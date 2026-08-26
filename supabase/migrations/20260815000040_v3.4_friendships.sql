-- v3.4 Task 2: Replace the group mechanic with real pairwise friendships.
--
-- Filename note: the plan's own File Structure section names this file
-- 20260815000041_v3.4_friendships.sql, assuming a prior doc-only marker migration
-- (20260815000040_v3.4_shared_auth_helper_note.sql) would exist from Task 1. Confirmed directly
-- against the repo before writing this: Task 1's actual deliverables/DoD never call for a
-- migration file at all (only authHelpers.ts + 8 edited TS files - see its own report), and no
-- such file exists in supabase/migrations/. The latest migration on disk is 20260815000039, so
-- 20260815000040 is the actual next free sequential number - used here instead of manufacturing a
-- gap at 000040 to match the plan's assumed-but-never-created filename.
--
-- Replaces friend_groups/group_memberships/invite_codes' group semantics and the
-- users_share_a_group() helper with a direct friendships table between two users and an
-- are_friends() helper (Decision 1: instant connect on redemption, no accept/decline step).
-- invite_codes.group_id is dropped outright, not repointed (Decision 2).
--
-- Every RLS policy/function/trigger that currently calls users_share_a_group() is swapped to
-- are_friends() in this same migration. Out of scope (confirmed unchanged, verified directly):
-- study_room_invitees/its RLS - already migrated off group-sharing in 20260815000039 (that
-- migration's own header comment: "This drops users_share_a_group(owner_user_id, auth.uid())
-- from both policies entirely").
--
-- Pre-flight note on delete_account_data(): the plan's proposed rewrite below claims to copy
-- "everything else... verbatim from the current 20260815000038 version" apart from the
-- friend-model section. Confirmed directly against the live migration history before writing
-- this: the actual current version is 20260815000039 (not 000038) - and 20260815000039 added two
-- study_room_invitees delete statements that 000038 did not have (fixing a real
-- "Database error deleting user" bug for any account owning or invited to a room). The plan's
-- literal function body omits those two statements entirely. Applying it verbatim would silently
-- regress that fix for any account with study_room_invitees rows - study_room_invitees is
-- explicitly untouched/out of scope for this task, so its existing cleanup must be preserved, not
-- dropped. Both statements are kept below, unchanged from 20260815000039.
--
-- Second, separate pre-flight finding on the SAME function, found by diffing 20260815000038's
-- body against 20260815000039's actual live body line-by-line rather than trusting 20260815000039's
-- own header comment ("Every other line below is copied verbatim from 20260815000038 - only the
-- two new study_room_invitees statements are added"): that claim is false as shipped.
-- 20260815000039's real body is MISSING both the `delete from unlock_requests ...`/
-- `update unlock_requests set resolved_by = null ...` pair AND the
-- `delete from temp_passcode_requests ...` statement that 20260815000038 had immediately after its
-- own session_end_requests block - eight lines silently dropped between those two migrations, not
-- documented anywhere. unlock_requests.requester_user_id/resolved_by and
-- temp_passcode_requests.requester_user_id/friend_user_id all reference auth.users(id) with no ON
-- DELETE CASCADE (20260815000001), so this is a live, currently-shipped regression: right now,
-- deleting any account that ever created or resolved an unlock_request, or that was ever a
-- requester or assigned friend on a temp_passcode_request, fails outright with "Database error
-- deleting user" - the exact bug class 20260815000039 itself found and fixed for
-- study_room_invitees/profiles/session_end_requests, reintroduced for these two tables in the same
-- migration. Since this function is being fully rewritten in this migration regardless (`create or
-- replace function`, not a smaller ALTER), and Task 3's own migration is the one that properly
-- retires unlock_requests/temp_passcode_requests, leaving this known FK-violation bug in place for
-- one more migration purely to match 20260815000039's body byte-for-byte would be reproducing a
-- bug I already know about rather than fixing a four-line restoration - not "AS-IS" in any sense
-- that serves this task's own account-deletion DoD check. Both blocks are restored below, verbatim
-- from 20260815000038 (their last-known-correct form) - Task 3 replaces this whole area again next
-- migration regardless, so this is a strictly transitional fix.

-- === New friendships table ===
create table friendships (
  user_id_a     uuid not null references auth.users(id),
  user_id_b     uuid not null references auth.users(id),
  initiated_by  uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  primary key (user_id_a, user_id_b),
  -- Canonical ordering means each pair has exactly one row regardless of who redeemed whose
  -- code, and are_friends() below never has to check both orderings.
  constraint friendships_canonical_order check (user_id_a < user_id_b),
  constraint friendships_initiated_by_is_a_party
    check (initiated_by = user_id_a or initiated_by = user_id_b)
);

alter table friendships enable row level security;

create policy "either party can read their friendship"
  on friendships for select
  using (user_id_a = auth.uid() or user_id_b = auth.uid());

create policy "either party can remove their friendship"
  on friendships for delete
  using (user_id_a = auth.uid() or user_id_b = auth.uid());

-- No client-reachable INSERT path at all, by design - mirrors invite_codes' own fully-revoked-
-- UPDATE precedent (20260815000025) and group_memberships' redeem-only INSERT gate. The ONLY way
-- a friendships row is ever created is through redeem_invite_code() below (SECURITY DEFINER,
-- bypasses RLS entirely), so there is deliberately no INSERT policy and no grant of INSERT to
-- authenticated.
grant select, delete on friendships to authenticated;
grant select, insert, update, delete on friendships to service_role;

-- === are_friends() - replaces users_share_a_group() ===
create or replace function public.are_friends(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from friendships
    where user_id_a = least(p_user_a, p_user_b)
      and user_id_b = greatest(p_user_a, p_user_b)
  );
$$;

revoke all on function public.are_friends(uuid, uuid) from public;
grant execute on function public.are_friends(uuid, uuid) to authenticated, service_role;

-- === invite_codes: drop group_id, simplify INSERT policy (Decision 2) ===
-- Deviation from the plan's literal statement order: the plan's SQL drops the group_id column
-- BEFORE dropping the policy that references it in its USING/WITH CHECK clause. Reproduced
-- directly against the live project: `alter table invite_codes drop column group_id` in that
-- order fails outright with "cannot drop column group_id ... because other objects depend on it"
-- (policy "group members can create invite codes for their group" depends on it) - Postgres
-- requires the dependent policy to be dropped first. Fixed by dropping the policy before the
-- column (transaction rolled back cleanly on the first attempt - see scripts/apply-migrations.mjs,
-- no partial state to clean up).
drop policy "group members can create invite codes for their group" on invite_codes;
alter table invite_codes drop column group_id;

create policy "signed-in users can create invite codes for themselves"
  on invite_codes for insert
  with check (created_by = auth.uid());
-- SELECT policy ("creators and redeemers can read their own invite codes", 20260815000025) is
-- unchanged - confirmed directly, it never referenced group_id or group_memberships to begin
-- with.

-- === redeem_invite_code(): creates a friendships row instead of a group_memberships row ===
-- Second deviation from the plan's literal SQL, found the same live-testing way: `create or
-- replace function` cannot change an existing function's RETURN TYPE (the live function returns
-- `group_memberships`; this version returns `friendships`) - Postgres rejects this outright with
-- "cannot change return type of existing function" / "Use DROP FUNCTION redeem_invite_code(text)
-- first." Fixed by dropping the old signature before redefining it.
drop function public.redeem_invite_code(text);

create function public.redeem_invite_code(p_code text)
returns friendships
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_creator_id uuid;
  v_a uuid;
  v_b uuid;
  v_friendship friendships;
begin
  if v_user_id is null then raise exception 'Not signed in.'; end if;

  select ic.created_by into v_creator_id
    from invite_codes ic
    where ic.code = p_code and ic.used_by is null and ic.expires_at > now()
    for update;

  if v_creator_id is null then
    raise exception 'Invite code not found, expired, or already used.';
  end if;
  if v_creator_id = v_user_id then
    raise exception 'You cannot redeem your own invite code.';
  end if;

  update invite_codes set used_by = v_user_id where code = p_code;

  v_a := least(v_creator_id, v_user_id);
  v_b := greatest(v_creator_id, v_user_id);

  insert into friendships (user_id_a, user_id_b, initiated_by)
  values (v_a, v_b, v_creator_id)
  on conflict (user_id_a, user_id_b) do nothing;

  select f.* into v_friendship from friendships f
   where f.user_id_a = v_a and f.user_id_b = v_b;

  return v_friendship;
end;
$$;

-- === friendship_settings: retarget the auto-create trigger from group_memberships to
-- friendships. Same insert-both-directions/on-conflict-do-nothing shape as the current trigger -
-- only what it fires ON, and how it derives "the other user", changes. ===
drop trigger group_memberships_create_friendship_settings on group_memberships;
drop function public.create_friendship_settings_for_new_member();

create or replace function public.create_friendship_settings_for_new_friendship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into friendship_settings (user_id, friend_user_id)
  values (new.user_id_a, new.user_id_b)
  on conflict (user_id, friend_user_id) do nothing;

  insert into friendship_settings (user_id, friend_user_id)
  values (new.user_id_b, new.user_id_a)
  on conflict (user_id, friend_user_id) do nothing;

  return new;
end;
$$;

create trigger friendships_create_friendship_settings
  after insert on friendships
  for each row
  execute function public.create_friendship_settings_for_new_friendship();

-- friendship_settings INSERT policy - swap users_share_a_group() for are_friends():
drop policy "users can insert their own settings rows only toward a shared-group friend" on friendship_settings;
create policy "users can insert their own settings rows only toward an actual friend"
  on friendship_settings for insert
  with check (
    user_id = auth.uid()
    and are_friends(user_id, friend_user_id)
  );

-- === The 5 friend_has_granted_*_visibility functions - swap users_share_a_group() for
-- are_friends() (identical shape x5, only the trailing share_* column name differs). Confirmed
-- directly against the live 20260815000012 definitions before writing this - friend_has_granted_
-- live_visibility is NOT one of these five (it checks only friendship_settings.send_live_nudges,
-- no group/friend floor of its own), matching the plan exactly. ===
create or replace function public.friend_has_granted_distraction_visibility(
  p_subject_user_id uuid, p_viewer_user_id uuid
) returns boolean language sql stable security definer set search_path = public as $$
  select are_friends(p_subject_user_id, p_viewer_user_id)
    and exists (select 1 from friendship_settings
      where user_id = p_subject_user_id and friend_user_id = p_viewer_user_id
        and share_distraction_attempts = true);
$$;

create or replace function public.friend_has_granted_domain_visibility(
  p_subject_user_id uuid, p_viewer_user_id uuid
) returns boolean language sql stable security definer set search_path = public as $$
  select are_friends(p_subject_user_id, p_viewer_user_id)
    and exists (select 1 from friendship_settings
      where user_id = p_subject_user_id and friend_user_id = p_viewer_user_id
        and share_current_domain = true);
$$;

create or replace function public.friend_has_granted_goal_visibility(
  p_subject_user_id uuid, p_viewer_user_id uuid
) returns boolean language sql stable security definer set search_path = public as $$
  select are_friends(p_subject_user_id, p_viewer_user_id)
    and exists (select 1 from friendship_settings
      where user_id = p_subject_user_id and friend_user_id = p_viewer_user_id
        and share_goal_text = true);
$$;

create or replace function public.friend_has_granted_intervention_count_visibility(
  p_subject_user_id uuid, p_viewer_user_id uuid
) returns boolean language sql stable security definer set search_path = public as $$
  select are_friends(p_subject_user_id, p_viewer_user_id)
    and exists (select 1 from friendship_settings
      where user_id = p_subject_user_id and friend_user_id = p_viewer_user_id
        and share_intervention_count = true);
$$;

create or replace function public.friend_has_granted_full_history_visibility(
  p_subject_user_id uuid, p_viewer_user_id uuid
) returns boolean language sql stable security definer set search_path = public as $$
  select are_friends(p_subject_user_id, p_viewer_user_id)
    and exists (select 1 from friendship_settings
      where user_id = p_subject_user_id and friend_user_id = p_viewer_user_id
        and share_full_history = true);
$$;

revoke all on function public.friend_has_granted_distraction_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_domain_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_goal_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_intervention_count_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_full_history_visibility(uuid, uuid) from public;
grant execute on function public.friend_has_granted_distraction_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_domain_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_goal_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_intervention_count_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_full_history_visibility(uuid, uuid)
  to authenticated, service_role;

-- === can_send_nudge(): swap users_share_a_group() for are_friends() only in this migration -
-- Task 8 rewrites this function AGAIN to split the cooldown column; this migration's version is
-- the intermediate "friends model only" step, not the final one. ===
create or replace function public.can_send_nudge(
  p_sender_user_id uuid, p_recipient_user_id uuid
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_sender_send_allowed boolean;
  v_recipient_receive_allowed boolean;
  v_cooldown_seconds integer;
  v_last_sent_at timestamptz;
begin
  if not are_friends(p_sender_user_id, p_recipient_user_id) then
    return false;
  end if;

  select send_live_nudges into v_sender_send_allowed
    from friendship_settings
    where user_id = p_sender_user_id and friend_user_id = p_recipient_user_id;
  if not found or v_sender_send_allowed is not true then return false; end if;

  select receive_live_nudges, nudge_cooldown_seconds
    into v_recipient_receive_allowed, v_cooldown_seconds
    from friendship_settings
    where user_id = p_recipient_user_id and friend_user_id = p_sender_user_id;
  if not found or v_recipient_receive_allowed is not true then return false; end if;

  select max(sent_at) into v_last_sent_at
    from nudges
    where sender_user_id = p_sender_user_id and recipient_user_id = p_recipient_user_id;
  if v_last_sent_at is not null
     and v_last_sent_at > now() - make_interval(secs => v_cooldown_seconds) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.can_send_nudge(uuid, uuid) from public;
grant execute on function public.can_send_nudge(uuid, uuid) to authenticated, service_role;

-- === producer_tag_sends INSERT policy: swap users_share_a_group() for are_friends() only in
-- this migration - Task 8 rewrites this policy AGAIN to add the audio-cooldown gate. ===
drop policy "senders can create sends for their own tags to an actual friend or a room they belong to" on producer_tag_sends;
create policy "senders can create sends for their own tags to an actual friend or a room they belong to"
  on producer_tag_sends
  for insert
  to authenticated
  with check (
    sender_user_id = auth.uid()
    and is_producer_tag_owner(producer_tag_sends.tag_id, auth.uid())
    and (
      (
        recipient_user_id is not null
        and are_friends(sender_user_id, recipient_user_id)
      )
      or (
        recipient_room_id is not null
        and exists (
          select 1 from study_rooms sr
          where sr.id = recipient_room_id
            and (
              sr.owner_user_id = auth.uid()
              or exists (
                select 1 from study_room_participants srp
                where srp.room_id = sr.id and srp.user_id = auth.uid()
              )
            )
        )
      )
    )
  );

-- === temp_passcode_requests INSERT policy: swap users_share_a_group() for are_friends() -
-- this table is dropped outright in Task 3, so this is a short-lived intermediate state within
-- this same migration file's execution, not something that ships to production separately. Kept
-- as an explicit statement anyway (rather than skipped) so this migration is independently
-- correct if ever inspected on its own, and so Task 3's DROP TABLE has a clean, RLS-consistent
-- table to drop rather than one mid-migration in an inconsistent state. ===
drop policy "users can create their own genuinely-pending temp passcode requests" on temp_passcode_requests;
create policy "users can create their own genuinely-pending temp passcode requests"
  on temp_passcode_requests for insert
  with check (
    requester_user_id = auth.uid()
    and status = 'pending'
    and expires_at is null
    and requester_user_id <> friend_user_id
    and are_friends(requester_user_id, friend_user_id)
  );

-- === profiles SELECT policy: swap users_share_a_group() for are_friends() ===
drop policy "self or group-mate can read a profile" on profiles;
create policy "self or friend can read a profile"
  on profiles for select
  using (
    user_id = auth.uid()
    or are_friends(user_id, auth.uid())
  );

-- === Additional call sites, found by actually attempting the DROP TABLE statements below against
-- the live project rather than trusting the plan's enumerated list alone (Decision 8's own
-- caution generalized: verify, don't assume). `drop table group_memberships` failed outright with
-- "cannot drop table group_memberships because other objects depend on it", naming SEVEN live
-- objects the plan's Interfaces section never mentions - all of them raw double-self-joins on
-- group_memberships written BEFORE users_share_a_group() existed (20260815000008/000011/000012 all
-- predate 20260815000012's helper... 000012 itself introduces the raw form in the same migration
-- that adds the helper, then never retrofits its own policy/function to use it) and never
-- retrofitted since - the exact "one route closed, structurally identical sibling left open"
-- pattern this codebase's own migration history calls out repeatedly (see 20260815000029's header
-- comment for the most recent prior instance). A full non-comment grep for every remaining
-- `group_memberships`/`friend_groups` occurrence across supabase/migrations/*.sql, cross-checked
-- against which migration last redefined each object, confirms these seven are the complete set:
-- unlock_requests' SELECT+UPDATE policies (20260815000008), daily_digests' SELECT policy
-- (20260815000011), session_status_events' SELECT policy AND fetch_friend_event_details() function
-- body (20260815000012, both), and session_end_requests' SELECT+UPDATE policies (20260815000038).
-- Every one of these tables is otherwise untouched/out of scope for Task 2 (unlock_requests and
-- session_end_requests are Task 3's; daily_digests and session_status_events aren't named in any
-- near task at all) - but all of them still exist and are live right now, so their RLS must keep
-- working through the gap between this migration landing and Task 3's, and the DROP TABLE
-- statements below cannot succeed at all while they still hold a hard dependency on
-- group_memberships. Each is swapped from the raw group-membership self-join to
-- are_friends(requester/subject/owner, auth.uid()) - the direct pairwise equivalent of "shares a
-- group with" - with no other change to any policy's surrounding logic (first-responder-wins
-- guards, opted-in visibility gates, distraction-type redaction, etc. are all preserved verbatim).

drop policy "requester resolver or pending-group-member can read unlock requests" on unlock_requests;
create policy "requester resolver or pending-friend can read unlock requests"
  on unlock_requests for select
  using (
    requester_user_id = auth.uid()
    or resolved_by = auth.uid()
    or (
      status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  );

drop policy "requester or pending-group-member can resolve unlock requests" on unlock_requests;
create policy "requester or pending-friend can resolve unlock requests"
  on unlock_requests for update
  using (
    requester_user_id = auth.uid()
    or (
      status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  )
  with check (
    resolved_by = auth.uid()
    and status in ('approved', 'denied')
  );

drop policy "subject or digest-opted-in group-mate can read a daily digest" on daily_digests;
create policy "subject or digest-opted-in friend can read a daily digest"
  on daily_digests for select
  using (
    subject_user_id = auth.uid()
    or (
      are_friends(subject_user_id, auth.uid())
      and friend_has_granted_digest_visibility(daily_digests.subject_user_id, auth.uid())
    )
  );

drop policy "group members can read visible friend session events" on session_status_events;
create policy "friends can read visible friend session events"
  on session_status_events for select
  using (
    are_friends(session_status_events.user_id, auth.uid())
    and friend_has_granted_live_visibility(session_status_events.user_id, auth.uid())
    and (
      session_status_events.type <> 'DISTRACTION_ATTEMPT'
      or friend_has_granted_distraction_visibility(session_status_events.user_id, auth.uid())
    )
  );

-- fetch_friend_event_details: same signature (create or replace is sufficient, no return-type
-- change), only the group-membership subquery inside the body swaps to are_friends().
create or replace function public.fetch_friend_event_details(p_event_ids uuid[])
returns table (
  id uuid,
  hostname text,
  goal_text text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sse.id,
    case
      when sse.user_id = auth.uid() then sse.hostname
      when friend_has_granted_domain_visibility(sse.user_id, auth.uid()) then sse.hostname
      else null
    end as hostname,
    case
      when sse.user_id = auth.uid() then sse.goal_text
      when friend_has_granted_goal_visibility(sse.user_id, auth.uid()) then sse.goal_text
      else null
    end as goal_text
  from session_status_events sse
  where sse.id = any(p_event_ids)
    and (
      sse.user_id = auth.uid()
      or (
        are_friends(sse.user_id, auth.uid())
        and friend_has_granted_live_visibility(sse.user_id, auth.uid())
        and (
          sse.type <> 'DISTRACTION_ATTEMPT'
          or friend_has_granted_distraction_visibility(sse.user_id, auth.uid())
        )
      )
    );
$$;

drop policy "requester resolver or pending-group-member can read session-end requests" on session_end_requests;
create policy "requester resolver or pending-friend can read session-end requests"
  on session_end_requests for select
  using (
    requester_user_id = auth.uid()
    or resolved_by = auth.uid()
    or (
      status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  );

drop policy "requester or pending-group-member can resolve session-end requests" on session_end_requests;
create policy "requester or pending-friend can resolve session-end requests"
  on session_end_requests for update
  using (
    requester_user_id = auth.uid()
    or (
      status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  )
  with check (
    resolved_by = auth.uid()
    and status in ('approved', 'denied')
  );

-- === Drop the old group mechanic entirely - no data migration, per your explicit go-ahead ===
--
-- Third deviation from the plan's literal statement order, found the same live-testing way as the
-- two deviations noted above (invite_codes.group_id / redeem_invite_code()'s return type): running
-- this section in the plan's literal order (drop both tables, then the four helper functions)
-- failed outright against the live project, in two successive rounds once each surfaced failure
-- was fixed and the migration retried:
--
--   Round 1: "cannot drop table group_memberships because other objects depend on it" / "policy
--   \"members can read their groups\" on table friend_groups depends on table group_memberships" -
--   a raw subquery from friend_groups' own SELECT policy (20260815000002) into group_memberships,
--   never routed through a SECURITY DEFINER helper, so it isn't caught by the "swap every
--   users_share_a_group() caller" sweep above at all (this policy never called
--   users_share_a_group() - it predates that helper and does its own raw membership check).
--
--   Round 2, after dropping that one policy first: "cannot drop function is_group_member(uuid,
--   uuid) because other objects depend on it" / "policy \"members can read memberships of their
--   own groups\" on table group_memberships depends on function is_group_member(uuid,uuid)" - the
--   OPPOSITE direction of dependency from Round 1: group_memberships' own SELECT policy
--   (20260815000003's recursion fix) calls is_group_member() (and, same shape, its own INSERT
--   policy from 20260815000005 calls is_group_owner()+has_redeemed_invite_code(), and its own
--   DELETE policy from 20260815000028 calls is_group_owner() again) - `language sql` functions
--   (20260815000003/20260815000005) get a real pg_depend edge recorded against every relation
--   their body queries at CREATE time (unlike `language plpgsql`, whose body is opaque text until
--   executed and is NOT dependency-tracked this way - this is exactly why delete_account_data()'s
--   rewrite below, which still textually references friend_groups/group_memberships in its OLD
--   form until this migration's own `create or replace` further down replaces it, never blocks
--   anything here) - so a `language sql` function can't be dropped while a still-live policy still
--   calls it, even a policy on the very table about to be dropped.
--
-- Both rounds are the same underlying shape: a dependency edge pointing the OPPOSITE direction
-- from what "drop the tables, then their helper functions" assumes - the fix is to explicitly drop
-- every policy that could block anything (both the one cross-table policy on friend_groups AND
-- group_memberships' own three policies, rather than assuming a table drop's own implicit policy
-- cleanup happens early enough) strictly before any function or table drop, so nothing is ever
-- asked to disappear while something else still points at it. Verified live in this exact order
-- with no further errors.
drop trigger group_memberships_unredeem_invite_code on group_memberships;
drop function public.unredeem_invite_code_on_membership_delete();

drop policy "members can read their groups" on friend_groups;
drop policy "members can read memberships of their own groups" on group_memberships;
drop policy "users can insert their own membership row via a redeemed invite or as owner" on group_memberships;
drop policy "member can leave or owner can remove a member" on group_memberships;

drop function public.is_group_member(uuid, uuid);
drop function public.is_group_owner(uuid, uuid);
drop function public.has_redeemed_invite_code(uuid, uuid);
drop function public.users_share_a_group(uuid, uuid);

drop table group_memberships;
drop table friend_groups;

-- === delete_account_data(): friendships half of the rewrite (Task 3 rewrites this function
-- again for the friend_requests half - both edits land in this same version, in build order).
-- Base body is the ACTUAL live 20260815000039 version (confirmed directly, see this migration's
-- header comment - not 20260815000038 as the plan's prose claimed), with:
--   - the friend_groups/group_memberships reassign-and-delete sections removed entirely and
--     replaced by one friendships delete, since there is no "owner" concept left to reassign;
--     invite_codes' own user-scoped cleanup (null used_by, delete created_by rows) is PRESERVED,
--     just moved out from under the now-gone friend_groups branch it used to live inside - see
--     that statement's own comment further down for why (found missing by live-testing account
--     deletion, not carried over correctly on the first pass through this rewrite either);
--   - the unlock_requests/temp_passcode_requests blocks RESTORED from 20260815000038 (see this
--     migration's second header note - 20260815000039 silently dropped both despite claiming a
--     verbatim copy; left as dropped here would carry a live FK-violation account-deletion bug
--     forward). session_end_requests is untouched/AS-IS, since 20260815000039 did carry it
--     forward correctly. Task 3 replaces this whole three-table block in the next migration.
--   - the study_room_invitees sections left AS-IS (out of scope for this task, untouched).
create or replace function public.delete_account_data(p_user_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audio_urls text[];
begin
  delete from producer_tag_sends
   where sender_user_id = p_user_id
      or recipient_user_id = p_user_id
      or tag_id in (select id from producer_tags where user_id = p_user_id);

  with deleted as (
    delete from producer_tags where user_id = p_user_id
    returning audio_url
  )
  select coalesce(array_agg(audio_url), array[]::text[]) into v_audio_urls from deleted;

  delete from nudges
   where sender_user_id = p_user_id or recipient_user_id = p_user_id;

  delete from daily_digests where subject_user_id = p_user_id;

  delete from coaching_message_requests where user_id = p_user_id;

  delete from session_status_events where user_id = p_user_id;

  delete from profiles where user_id = p_user_id;

  -- unlock_requests/temp_passcode_requests/session_end_requests: unchanged in THIS migration,
  -- see this task's own comment above - Task 3's migration replaces this whole block.
  delete from session_end_requests where requester_user_id = p_user_id;
  update session_end_requests set resolved_by = null where resolved_by = p_user_id;

  delete from unlock_requests where requester_user_id = p_user_id;
  update unlock_requests set resolved_by = null where resolved_by = p_user_id;

  delete from temp_passcode_requests
   where requester_user_id = p_user_id or friend_user_id = p_user_id;

  -- study_room_invitees: unchanged in THIS migration (out of scope for Task 2) - preserved
  -- verbatim from 20260815000039, which added these two statements after finding that omitting
  -- them causes "Database error deleting user" for any account owning or invited to a room. See
  -- this migration's header comment for why the plan's own proposed body (based on a stale read of
  -- 20260815000038) omitted these and why they're restored here.
  delete from study_room_invitees
   where room_id in (select id from study_rooms where owner_user_id = p_user_id);
  delete from study_room_invitees where user_id = p_user_id;

  delete from study_room_participants
   where user_id = p_user_id
     and room_id not in (select id from study_rooms where owner_user_id = p_user_id);

  update producer_tag_sends
     set recipient_room_id = null
   where recipient_room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_room_participants
   where room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_rooms where owner_user_id = p_user_id;

  -- === friendships: symmetric delete, no reassignment logic needed - there is no "owner"
  -- concept in a pairwise model, unlike friend_groups' owner-reassign-or-cascade handling this
  -- replaces. Either party leaving simply removes the one row between them. ===
  delete from friendships where user_id_a = p_user_id or user_id_b = p_user_id;

  -- === invite_codes: found missing by actually exercising account deletion against the live
  -- project (via scripts/verify-friendships.mjs), not by reading the plan's SQL alone -
  -- `admin.auth.admin.deleteUser()` failed outright with "Database error deleting user" for any
  -- account that had ever generated an invite code, the exact bug class this migration's own
  -- header comment already found and fixed once for unlock_requests/temp_passcode_requests.
  -- invite_codes.created_by/used_by both reference auth.users(id) with no ON DELETE CASCADE
  -- (20260815000001) - the pre-v3.4 version of this function DID clean these up, but only as an
  -- incidental part of its friend_groups-deletion branch (delete codes for groups about to be
  -- deleted, then null out used_by / delete created_by codes for the caller specifically) - that
  -- branch is gone entirely under the pairwise model (no group to delete), and its user-scoped
  -- cleanup needs to survive independently of it. used_by is nulled (not deleted) rather than the
  -- row removed, preserving the OTHER party's own invite_codes row/history the same way
  -- unlock_requests' resolved_by nulling already does elsewhere in this function - only rows the
  -- caller themselves created are deleted outright.
  update invite_codes set used_by = null where used_by = p_user_id;
  delete from invite_codes where created_by = p_user_id;

  delete from friendship_settings
   where user_id = p_user_id or friend_user_id = p_user_id;

  return v_audio_urls;
end;
$$;
