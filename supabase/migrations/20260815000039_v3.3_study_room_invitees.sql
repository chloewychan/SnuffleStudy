-- v3.3 Task 13: Invite-only study rooms.
--
-- Prior state, confirmed live against the current project before writing this (per this task's
-- own instruction to verify, not assume, since two earlier tasks in this run already touched
-- these two tables): study_rooms' current SELECT policy is named exactly
-- "owner group-mates and participants can read study rooms" (widened by
-- 20260815000019_v2_study_rooms_group_visibility_and_join_gate.sql), and
-- study_room_participants' current INSERT policy is named exactly
-- "users can insert their own participant row for a discoverable room" (also 20260815000019) -
-- both match this migration's `drop policy` targets exactly, confirmed via a live `pg_policies`
-- query, not just by reading the migration history. (One added wrinkle, also confirmed live: that
-- INSERT policy's name is 66 characters, one over Postgres' 63-byte NAMEDATALEN identifier limit,
-- so the name Postgres actually stored - and what `pg_policies` reports - is silently truncated to
-- "...for a discoverable r". This does NOT break the `drop policy "...for a discoverable room" on
-- study_room_participants;` statement below: Postgres applies the identical truncation to the
-- identifier in a DROP statement before looking it up, so the plan's literal long-form text
-- resolves to the same truncated stored name and drops it correctly - verified directly with a
-- scratch table before relying on it here, not assumed from documentation.)
--
-- Task 6's "owner can archive their own room" UPDATE policy (20260815000033) is untouched by this
-- migration - confirmed independent: it's a separate policy (UPDATE, not SELECT/INSERT) on a
-- separate concern (archiving vs. discoverability), with its own predicate
-- (`owner_user_id = auth.uid()`) that doesn't reference study_room_invitees at all and needs no
-- change here.
create table study_room_invitees (
  room_id     uuid not null references study_rooms(id),
  user_id     uuid not null references auth.users(id),
  invited_by  uuid not null references auth.users(id),
  invited_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);

alter table study_room_invitees enable row level security;

-- Gap found by actually exercising this end-to-end against the live DB, not by reading the plan's
-- own literal SQL alone: the plan's literal text for "owner can manage invitees for their own
-- room" is a RAW subquery into study_rooms -
-- `exists (select 1 from study_rooms sr where sr.id = study_room_invitees.room_id and
-- sr.owner_user_id = auth.uid())` - which, combined with this migration's own new
-- study_rooms SELECT policy (below) raw-subquerying INTO study_room_invitees, forms a mutual
-- A-queries-B / B-queries-A RLS cycle - the EXACT bug class (and in fact one of the exact two
-- tables) 20260815000003_v2_fix_grants_and_rls_recursion.sql already fixed once for
-- study_rooms/study_room_participants ("study_rooms and study_room_participants additionally form
-- a mutual A-queries-B / B-queries-A cycle... which is the same failure mode across two tables").
-- Reproduced directly: creating a study room (`.insert(...).select().single()`, the exact call
-- studyRoomApi.ts's createRoom() makes) failed outright with "infinite recursion detected in
-- policy for relation \"study_rooms\"" against the plan's literal SQL, applied verbatim.
--
-- Fixed the same way 20260815000003 fixed the original cycle: route this policy through
-- `is_room_owner(p_room_id, p_user_id)` (20260815000003's existing SECURITY DEFINER helper -
-- already used by study_room_participants' own SELECT policy for exactly this purpose - reused
-- here rather than duplicated) instead of a raw subquery. A SECURITY DEFINER function's internal
-- query runs as the function's owner (the table-owning `postgres` role, never subjected to FORCE
-- ROW LEVEL SECURITY - see 20260815000003's own header comment), which bypasses RLS on study_rooms
-- entirely for that one internal read - so evaluating this policy no longer re-triggers
-- study_rooms' own SELECT policy, breaking the cycle. This is a MINIMAL, targeted fix: only this
-- one policy needed to change - study_rooms' new SELECT policy below still raw-subqueries INTO
-- study_room_invitees (matching the plan's literal text) and that remains safe, precisely because
-- this table's policies (both this one and "invitee can read their own invitation" below) no
-- longer raw-subquery back into study_rooms - the exact same "one-directional raw subquery is fine
-- as long as the far side never subqueries back" shape 20260815000019's own
-- study_rooms -> study_room_participants clause already relies on safely (verified by re-running
-- the full live verification script after this fix, with no further recursion anywhere in this
-- migration's policies).
create policy "owner can manage invitees for their own room"
  on study_room_invitees for all
  using (is_room_owner(study_room_invitees.room_id, auth.uid()))
  with check (is_room_owner(study_room_invitees.room_id, auth.uid()));

create policy "invitee can read their own invitation"
  on study_room_invitees for select
  using (user_id = auth.uid());

-- Gap found by actually exercising this end-to-end against the live DB (a real service-role
-- client), not by reading the plan's own literal SQL alone - the exact same category of bug this
-- codebase's migration history already has three precedents for this run alone
-- (20260815000035_v3.3_profiles_grants_and_account_deletion.sql's "Bug 1";
-- 20260815000038_v3.3_session_end_requests.sql's identical "Bug 1" for session_end_requests; both
-- found the same way).
--
-- The plan's literal SQL block for this task grants only `authenticated`. Every OTHER table in
-- this schema that references auth.users(id) grants BOTH `authenticated` AND `service_role` at the
-- table level, without exception (confirmed by grepping every `create table`/`grant` pair across
-- supabase/migrations/*.sql: friend_groups/group_memberships/invite_codes/friendship_settings/
-- session_status_events/unlock_requests/temp_passcode_requests/study_rooms/
-- study_room_participants/producer_tags/producer_tag_sends via 20260815000003; nudges via
-- 20260815000007; coaching_message_requests via 20260815000014; daily_digests via 20260815000010;
-- profiles via 20260815000035; session_end_requests via 20260815000038). Reproduced directly with a
-- live scratch script (a service-role client inserting/deleting a study_room_invitees row, the same
-- shape verify-*.mjs's own cleanup step always uses): the insert itself failed outright with
-- "permission denied for table study_room_invitees" before this grant was added, and continued to
-- fail identically for delete once insert was worked around by other means - `authenticated`'s own
-- privileges are fully described by its RLS policies above (there is no client-facing case this
-- table needs beyond select/insert/update/delete, all already covered by the two policies above),
-- while `service_role` needs full CRUD for admin/maintenance tooling and this codebase's own
-- verify-*.mjs scripts - same asymmetric-grant split 20260815000010/20260815000035/20260815000038
-- already use for exactly this reason.
grant select, insert, update, delete on study_room_invitees to authenticated, service_role;

-- Backfill: current participants of existing rooms keep access - see Decision 5
-- (docs/implementation_plans/V3.3_Implementation_Plan.md) for why the owner's own row is excluded
-- (redundant with study_rooms' owner clause, not incorrect either way).
insert into study_room_invitees (room_id, user_id, invited_by, invited_at)
select distinct srp.room_id, srp.user_id, sr.owner_user_id, now()
from study_room_participants srp
join study_rooms sr on sr.id = srp.room_id
where srp.user_id <> sr.owner_user_id
on conflict (room_id, user_id) do nothing;

-- Second gap on THIS policy, found the same live-testing way, distinct from the recursion fix
-- above: the plan's literal `exists (select 1 from study_room_participants srp where
-- srp.room_id = study_rooms.id and srp.user_id = auth.uid())` clause - copied verbatim from
-- 20260815000019's original "owner group-mates and participants" policy - does not filter on
-- `left_at is null`, so it matches ANY historical participant row, not just a currently-active one.
-- Before this task, that was harmless: group-sharing (`users_share_a_group`) was the real
-- visibility gate, and this clause only ever widened an ALREADY-visible set. This task removes
-- group-sharing as a visibility basis entirely, which turns the same unscoped clause into a
-- standing loophole: anyone who ever joined a room even once - and has since left AND had their
-- invite explicitly revoked - would retain read access to that room forever, defeating a core part
-- of "invite-only." This directly contradicts the plan's own Definition of Done text: "Account A
-- removes the invite - Account B, if not currently in the room, loses visibility to it again."
-- Reproduced directly: with the unscoped clause, a user who joined a room, left it, and then had
-- their invite removed could still read the room afterward - the DoD's own "not currently in the
-- room" case failed. Confirmed no other code path in this codebase depends on unscoped
-- past-participant visibility (grepped every `.from("study_rooms")` call site - createRoom/
-- listRooms/archiveRoom in studyRoomApi.ts only; none look up a room by id for a user who is
-- neither its owner nor a current participant). Fixed by scoping this clause to
-- `srp.left_at is null` - only a CURRENTLY-active participant gets automatic visibility through
-- this clause now (which is exactly what keeps an in-progress call's own participants able to see
-- the room they're literally in, the case this clause exists for at all - see the (c2) case in the
-- live verification script/report for why an ACTIVE participant must still pass here even with an
-- invite freshly revoked). A past-and-now-inactive participant's visibility depends entirely on the
-- invitee-table clause going forward, matching the DoD's own stated behavior. Confirmed via the
-- live verification script, both before this fix (failed) and after (passed).
drop policy "owner group-mates and participants can read study rooms" on study_rooms;
create policy "owner invitee or participant can read study rooms"
  on study_rooms for select
  using (
    owner_user_id = auth.uid()
    or exists (select 1 from study_room_invitees sri where sri.room_id = study_rooms.id and sri.user_id = auth.uid())
    or exists (
      select 1 from study_room_participants srp
      where srp.room_id = study_rooms.id and srp.user_id = auth.uid() and srp.left_at is null
    )
  );

drop policy "users can insert their own participant row for a discoverable room" on study_room_participants;
create policy "users can insert their own participant row for an invited room"
  on study_room_participants for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from study_rooms sr
      where sr.id = study_room_participants.room_id
        and (
          sr.owner_user_id = auth.uid()
          or exists (select 1 from study_room_invitees sri where sri.room_id = sr.id and sri.user_id = auth.uid())
        )
    )
  );
-- This drops `users_share_a_group(owner_user_id, auth.uid())` from both policies entirely - a room
-- is no longer visible or joinable purely by shared group membership.

-- Second gap, same category, found the same way: delete_account_data() (20260815000032, last
-- amended by 20260815000038 for session_end_requests) is the SECURITY DEFINER function
-- supabase/functions/delete-account/index.ts calls before it ever calls
-- adminClient.auth.admin.deleteUser() - its whole premise is "every app-schema row referencing this
-- user, across every table in this schema that has one" must be removed first, in FK-safe order, or
-- the auth.users delete fails outright (no FK anywhere in this schema has `on delete cascade` - see
-- 20260815000032's own header comment). study_room_invitees.user_id/invited_by both reference
-- auth.users(id), and this function predates this table entirely, so it was never taught about it -
-- reproduced directly with a live scratch script that mirrors the real Edge Function's exact
-- sequence (adminClient.rpc("delete_account_data", ...) THEN adminClient.auth.admin.deleteUser()):
-- both (a) deleting a user who was only an INVITEE on someone else's room, and (b) deleting a user
-- who OWNED a room that still had an active invitee, failed with "Database error deleting user"
-- until the fix below was applied - confirmed fixed by re-running the identical script afterward.
-- Any real signed-in user who is ever invited to (or invites someone to) a study room would hit
-- this exact failure on "Delete account" (AccountPage.tsx / AUTH_DELETE_ACCOUNT) - the identical
-- regression class 20260815000035/20260815000038 already fixed once each for
-- profiles/session_end_requests.
--
-- Fixed the same way: re-declaring the function (create or replace) with two new statements added,
-- placed immediately before the existing study_room_participants/study_rooms cascade section
-- (study_room_invitees.room_id references study_rooms(id) with no cascade, so any invitee row for a
-- room the caller owns is removed before that room's own `delete from study_rooms` statement runs,
-- so no row is left pointing at a room that no longer exists). The caller's own invitee rows on
-- rooms they do NOT own (rows where they're the invitee, not the owner) are deleted separately, by
-- user_id, since those aren't covered by the owned-room cascade. invited_by is not given its own
-- separate cleanup statement: this table's only INSERT path is the "owner can manage invitees for
-- their own room" policy above, whose `with check` requires `sr.owner_user_id = auth.uid()`, so
-- invited_by is always equal to the room's own owner_user_id for every row that can ever exist
-- (verified live: every invitee row this migration's own backfill inserts, and every row
-- addInvitee() can insert, sets invited_by to the inviting owner) - meaning every row where the
-- caller is invited_by is already a row on a room the caller owns, already covered by the
-- owned-room cascade's `room_id in (...)` deletion. Every other line below is copied verbatim from
-- 20260815000038 - only the two new study_room_invitees statements are added.
create or replace function public.delete_account_data(p_user_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audio_urls text[];
begin
  -- === Producer Tags: sends, then tags (capturing Storage paths first) ===
  delete from producer_tag_sends
   where sender_user_id = p_user_id
      or recipient_user_id = p_user_id
      or tag_id in (select id from producer_tags where user_id = p_user_id);

  with deleted as (
    delete from producer_tags where user_id = p_user_id
    returning audio_url
  )
  select coalesce(array_agg(audio_url), array[]::text[]) into v_audio_urls from deleted;

  -- === Simple single-owner-column tables ===
  delete from nudges
   where sender_user_id = p_user_id or recipient_user_id = p_user_id;

  delete from daily_digests where subject_user_id = p_user_id;

  delete from coaching_message_requests where user_id = p_user_id;

  delete from session_status_events where user_id = p_user_id;

  -- v3.3 Task 8 follow-up (20260815000035): profiles.user_id references auth.users(id) with no
  -- ON DELETE CASCADE, same as every other table in this function - must go before Step 3's
  -- auth.users delete, or that delete fails outright. No other table references profiles, so this
  -- has no ordering dependency of its own.
  delete from profiles where user_id = p_user_id;

  -- v3.3 Task 12 (20260815000038): session_end_requests.requester_user_id/resolved_by both
  -- reference auth.users(id) with no ON DELETE CASCADE, same as every other table in this
  -- function. Mirrors unlock_requests' treatment immediately below verbatim (delete the caller's
  -- own requests; null out resolved_by on requests the caller resolved for someone ELSE), per
  -- Decision 1's "session_end_requests mirrors unlock_requests" design.
  delete from session_end_requests where requester_user_id = p_user_id;
  update session_end_requests set resolved_by = null where resolved_by = p_user_id;

  -- v3.3 Task 13 (this migration): study_room_invitees.room_id references study_rooms(id) with no
  -- ON DELETE CASCADE - any invitee row for a room the caller owns must be removed before that
  -- room is deleted below, so no row is left pointing at a deleted room. See this migration's own
  -- header comment for why invited_by needs no separate cleanup statement (it's always the room's
  -- own owner, already covered here).
  delete from study_room_invitees
   where room_id in (select id from study_rooms where owner_user_id = p_user_id);

  -- v3.3 Task 13 (this migration): the caller's own invitee rows on rooms they do NOT own (rows
  -- where they were invited, not the inviting owner) - not covered by the owned-room cleanup
  -- above, and study_room_invitees.user_id references auth.users(id) with no ON DELETE CASCADE.
  delete from study_room_invitees where user_id = p_user_id;

  -- === study_room_participants: the caller's own participation rows in rooms they do NOT own
  -- (rooms they own are handled as a full cascade below, which also removes any of the caller's
  -- own remaining participant rows in their own rooms) ===
  delete from study_room_participants
   where user_id = p_user_id
     and room_id not in (select id from study_rooms where owner_user_id = p_user_id);

  -- === study_rooms owned by the caller: cascade (see 20260815000032's header comment for why
  -- this, unlike friend_groups, is a full cascade rather than an ownership reassignment) ===
  update producer_tag_sends
     set recipient_room_id = null
   where recipient_room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_room_participants
   where room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_rooms where owner_user_id = p_user_id;

  -- === friend_groups owned by the caller: reassign to the longest-standing remaining member if
  -- one exists (see 20260815000032's header comment); otherwise left for the "last member" branch
  -- below to catch once the caller's own membership row is gone ===
  update friend_groups fg
     set owner_user_id = (
       select gm.user_id
         from group_memberships gm
        where gm.group_id = fg.id
          and gm.user_id <> p_user_id
        order by gm.joined_at asc
        limit 1
     )
   where fg.owner_user_id = p_user_id
     and exists (
       select 1 from group_memberships gm2
        where gm2.group_id = fg.id and gm2.user_id <> p_user_id
     );

  -- === group_memberships: the caller's own rows in every group (owned-and-reassigned, owned-and-
  -- about-to-be-deleted, or plain member) - fires the existing
  -- group_memberships_unredeem_invite_code trigger (20260815000028), which un-redeems (nulls
  -- used_by, does not delete the row) any invite_codes row the caller redeemed to join. Doing this
  -- BEFORE the friend_groups "last member" cleanup below is what makes an owner-with-no-other-
  -- members group correctly show up as ownerless-and-memberless there. ===
  delete from group_memberships where user_id = p_user_id;

  -- === invite_codes: for groups about to be deleted outright (no members left, owner_user_id
  -- still = the caller since the reassignment above only fired when other members existed), remove
  -- their codes first - FK-required, invite_codes.group_id is NOT NULL and friend_groups is about
  -- to lose these rows next. ===
  delete from invite_codes
   where group_id in (select id from friend_groups where owner_user_id = p_user_id);

  -- Remaining invite_codes referencing the caller on groups NOT being deleted (reassigned groups,
  -- or any other group): null out used_by (redundant with the unredeem trigger above for the
  -- common case, kept as a defensive no-op for any row the trigger's per-group_id/user_id match
  -- didn't cover), then delete codes the caller created for any group.
  update invite_codes set used_by = null where used_by = p_user_id;
  delete from invite_codes where created_by = p_user_id;

  -- === friend_groups: now safe to delete outright - zero group_memberships rows reference these
  -- (the caller's own was just removed above, and owner_user_id still equalling p_user_id here
  -- means the earlier reassignment found no other member to hand it to) ===
  delete from friend_groups where owner_user_id = p_user_id;

  -- === friendship_settings: both directions ===
  delete from friendship_settings
   where user_id = p_user_id or friend_user_id = p_user_id;

  return v_audio_urls;
end;
$$;
