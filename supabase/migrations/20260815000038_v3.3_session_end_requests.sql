-- v3.3 Task 12: temporary pass to end a hard-restricted session early. Adds session_end_requests,
-- a table that mirrors unlock_requests (supabase/migrations/20260815000008's RLS shape) almost
-- exactly, retargeted at "end this session" instead of "unlock this hostname" - per Decision 1
-- (docs/implementation_plans/V3.3_Implementation_Plan.md): same "no assigned friend, any
-- pending-group-member can resolve, first-responder-wins" visibility model, since the scope doc
-- explicitly asks for a single button with no friend picker, not a per-friend assignment the way
-- temp_passcode_requests has.
--
-- This is a NEW table, not a retrofit of an existing one - so unlike unlock_requests (which
-- needed a separate follow-up migration, 20260815000008, to widen its original
-- "requester-or-resolver-only" policy to include pending-group-member visibility), this table's
-- RLS ships with the group-visibility shape built in from the start.
--
-- Deliberately NOT reusing unlock_requests itself (e.g. a `kind` discriminator column) - a
-- session-end request has no hostname, and giving it one just to satisfy unlock_requests' NOT
-- NULL hostname column would be a worse design than a small, purpose-built table. This mirrors how
-- temp_passcode_requests and unlock_requests are already two separate tables for two separate
-- concerns, not one shared one.
--
-- Security-critical note (see sessionEndRequestApi.ts's isApprovedForSelf and messageRouter.ts's
-- SESSION_END handler): RLS here governs who can READ or RESOLVE a row, not who is allowed to use
-- an approved row's id to actually end a session. The resolving friend legitimately gains read
-- access to a row they approved (via `resolved_by = auth.uid()` below) - that is by design, so
-- they can see the outcome of their own decision - but that same read access must never be
-- mistaken for authorization to use the request's id as their own temporary pass. That check lives
-- entirely in application code (isApprovedForSelf's explicit requester_user_id comparison), not in
-- this migration.
create table session_end_requests (
  id                 uuid primary key default gen_random_uuid(),
  session_id         text not null,
  requester_user_id  uuid not null references auth.users(id),
  status             text not null check (status in ('pending','approved','denied')),
  requested_at       timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid references auth.users(id)
);

alter table session_end_requests enable row level security;

create policy "users can create their own session-end requests"
  on session_end_requests for insert
  with check (requester_user_id = auth.uid());

create policy "requester resolver or pending-group-member can read session-end requests"
  on session_end_requests for select
  using (
    requester_user_id = auth.uid()
    or resolved_by = auth.uid()
    or (
      status = 'pending'
      and exists (
        select 1 from group_memberships gm_self
        join group_memberships gm_requester on gm_requester.group_id = gm_self.group_id
        where gm_self.user_id = auth.uid()
          and gm_requester.user_id = session_end_requests.requester_user_id
      )
    )
  );

create policy "requester or pending-group-member can resolve session-end requests"
  on session_end_requests for update
  using (
    requester_user_id = auth.uid()
    or (
      status = 'pending'
      and exists (
        select 1 from group_memberships gm_self
        join group_memberships gm_requester on gm_requester.group_id = gm_self.group_id
        where gm_self.user_id = auth.uid()
          and gm_requester.user_id = session_end_requests.requester_user_id
      )
    )
  )
  with check (
    resolved_by = auth.uid()
    and status in ('approved', 'denied')
  );

grant select, insert, update on session_end_requests to authenticated;

-- Gap found by actually exercising this end-to-end against the live DB (a real service-role
-- client, plus delete_account_data() below), not by reading the plan's own literal SQL alone -
-- same category of bug this codebase's migration history already has two precedents for
-- (20260815000003_v2_fix_grants_and_rls_recursion.sql's "Bug 1 - missing table-level GRANTs";
-- 20260815000035_v3.3_profiles_grants_and_account_deletion.sql's identical "Bug 1" for `profiles`,
-- found the same way).
--
-- The plan's literal SQL block for this task grants only `authenticated`. Every OTHER table in
-- this schema that references auth.users(id) grants BOTH `authenticated` AND `service_role` at
-- the table level, without exception - confirmed by grepping every `create table`/`grant` pair
-- across supabase/migrations/*.sql (friend_groups/group_memberships/invite_codes/
-- friendship_settings/session_status_events/unlock_requests/temp_passcode_requests/study_rooms/
-- study_room_participants/producer_tags/producer_tag_sends via 20260815000003; nudges via
-- 20260815000007; coaching_message_requests via 20260815000014; daily_digests via
-- 20260815000010; profiles via 20260815000035). Reproduced directly: a live verify-task12-live.mjs
-- run's own cleanup() step (a plain `admin.from("session_end_requests").delete()...` using the
-- service_role key, mirroring every other verify-*.mjs script's cleanup convention) failed with
-- "permission denied for table session_end_requests". `authenticated`'s own privileges are fully
-- described by its RLS policies above (select/insert/update only - there is no client-facing
-- delete policy on this table, so granting `authenticated` DELETE would be a no-op RLS would block
-- anyway), while `service_role` needs full CRUD for admin/maintenance tooling - same asymmetric
-- split 20260815000010's daily_digests migration and 20260815000035's profiles fix both already
-- use for exactly this reason.
grant select, insert, update, delete on session_end_requests to service_role;

-- Second, more serious bug found the same way, and by the same live script: delete_account_data()
-- (20260815000032_v3.2_account_deletion.sql, last amended by 20260815000035 for `profiles`) is the
-- SECURITY DEFINER function supabase/functions/delete-account/index.ts calls before it ever calls
-- adminClient.auth.admin.deleteUser() - its whole premise is "every app-schema row referencing
-- this user, across every table in this schema that has one" must be removed first, in FK-safe
-- order, or the auth.users delete fails outright (no FK anywhere in this schema has `on delete
-- cascade` - see 20260815000032's own header comment). session_end_requests.requester_user_id/
-- resolved_by are exactly such references, and this function predates this table entirely, so it
-- was never taught about it - reproduced directly: an ephemeral test requester/resolver pair (via
-- verify-task12-live.mjs) could not be deleted via admin.auth.admin.deleteUser() - "Database error
-- deleting user" - until the leftover session_end_requests row was removed by hand. Any real
-- signed-in user who ever requests or resolves a temporary pass to end a session early would hit
-- this exact failure on "Delete account" (AccountPage.tsx / AUTH_DELETE_ACCOUNT), the identical
-- regression class 20260815000035 already fixed once for `profiles`.
--
-- Fixed the same way 20260815000035 fixed it for `profiles` (create or replace - same technique
-- 20260815000029_v2_nudges_require_shared_group.sql uses to amend an existing SECURITY DEFINER
-- function in a later migration): re-declaring the function with one new section added, grouped
-- alongside unlock_requests' own treatment and using the IDENTICAL delete/null-out shape (delete
-- the caller's own requests; null out resolved_by on requests the caller resolved for someone
-- ELSE, preserving that other user's request history) - the exact design Decision 1
-- (docs/implementation_plans/V3.3_Implementation_Plan.md) already establishes session_end_requests
-- mirrors from unlock_requests in every other respect, so it mirrors it here too, for the same
-- reason. Every other line below is copied verbatim from 20260815000035 - only the one new
-- session_end_requests section is added.
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

  -- v3.3 Task 12 (this migration): session_end_requests.requester_user_id/resolved_by both
  -- reference auth.users(id) with no ON DELETE CASCADE, same as every other table in this
  -- function - see this migration's own header comment for the live-reproduced failure this
  -- fixes. Mirrors unlock_requests' treatment immediately below verbatim (delete the caller's own
  -- requests; null out resolved_by on requests the caller resolved for someone ELSE), per
  -- Decision 1's "session_end_requests mirrors unlock_requests" design.
  delete from session_end_requests where requester_user_id = p_user_id;
  update session_end_requests set resolved_by = null where resolved_by = p_user_id;

  -- === unlock_requests: delete the caller's own requests; null out resolved_by on requests
  -- the caller resolved for someone ELSE (preserving that other user's request history, the same
  -- "null a secondary reference rather than delete someone else's row" precedent
  -- 20260815000028's unredeem trigger already established for invite_codes.used_by) ===
  delete from unlock_requests where requester_user_id = p_user_id;
  update unlock_requests set resolved_by = null where resolved_by = p_user_id;

  -- === temp_passcode_requests: both requester_user_id and friend_user_id are NOT NULL, so unlike
  -- unlock_requests there is no nullable secondary reference to preserve - deleting is the only
  -- option when the caller is on either side. A request where the caller was the assigned friend
  -- (not the requester) is therefore also removed, losing the other party's record of that one
  -- request - accepted as an unavoidable consequence of a NOT NULL FK, not an oversight. ===
  delete from temp_passcode_requests
   where requester_user_id = p_user_id or friend_user_id = p_user_id;

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
