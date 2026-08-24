-- v3.3 Task 8 follow-up: two real bugs found by actually running a live-DB verification script
-- against the previous migration (20260815000034_v3.3_profiles.sql) - not just inspecting its
-- SQL, per this task's own instruction to treat the negative case seriously. Same category of
-- "found by running scripts against the live project, not by reading the schema" bug this
-- codebase's own migration history already has precedent for (20260815000003_v2_fix_grants_and_
-- rls_recursion.sql's "Bug 1 - missing table-level GRANTs").
--
-- === Bug 1: 20260815000034's grant statement omitted service_role ===
--
-- `grant select, insert, update on profiles to authenticated;` (the plan's own literal SQL,
-- applied verbatim in 20260815000034) only grants the `authenticated` role - every OTHER core
-- table in this schema grants both `authenticated` AND `service_role` at the table level (see
-- 20260815000003's `grant select, insert, update, delete on friend_groups, group_memberships,
-- invite_codes, friendship_settings, session_status_events, unlock_requests,
-- temp_passcode_requests, study_rooms, study_room_participants, producer_tags, producer_tag_sends
-- to authenticated, service_role;`, and 20260815000007/20260815000014's identical pattern for
-- nudges/coaching_message_requests). A service_role client (this codebase's verify-*.mjs scripts,
-- and any future admin/support tooling) got "permission denied for table profiles" on every
-- direct query - confirmed directly: a live verify-profiles.mjs run's own cleanup() step (a plain
-- `admin.from("profiles").delete()...` using the service_role key, mirroring every other
-- verify-*.mjs script's cleanup convention) failed with exactly that error, silently (the
-- verification script itself did not check that particular call's error - a gap in the ad hoc
-- script, not in application code), leaving an orphaned profiles row that then blocked deleting
-- the orphaned test user's auth.users row via admin.auth.admin.deleteUser (see Bug 2 below for why
-- that specific downstream failure matters beyond this one test run). Fixed by adding the missing
-- grant, using the same asymmetric split 20260815000010's daily_digests migration already
-- established for a table where `authenticated`'s privileges are fully described by its RLS
-- policies (select/insert/update only - there is no client-facing delete policy on profiles, so
-- granting `authenticated` DELETE would be a no-op RLS would block anyway) while `service_role`
-- gets full CRUD for admin/maintenance use.
grant select, insert, update, delete on profiles to service_role;

-- === Bug 2: delete_account_data() (20260815000032_v3.2_account_deletion.sql) predates `profiles`
-- and does not clean it up - a live, reproducible account-deletion regression ===
--
-- profiles.user_id is `references auth.users(id)` with no `on delete cascade` (this schema has
-- none anywhere - confirmed by the same grep 20260815000032's own header comment already
-- documents doing). delete_account_data() is the SECURITY DEFINER function
-- supabase/functions/delete-account/index.ts calls (Step 1) before it ever calls
-- adminClient.auth.admin.deleteUser() (Step 3) - its header comment's whole premise is "every
-- app-schema row referencing this user, across every table in this schema that has one" must be
-- removed first, in FK-safe order, or the auth.users delete in Step 3 fails outright. `profiles`
-- is now such a table, and this function was never updated for it (it was written before Task 8
-- existed). Reproduced directly: an ephemeral test user who saved a profiles row (via this task's
-- live verify-profiles.mjs script) could not be deleted via admin.auth.admin.deleteUser() -
-- "Database error deleting user" - until the leftover profiles row was removed by hand. Any real
-- signed-in user who ever saves a bunny/human name in BunnyTab.tsx would hit this exact failure on
-- "Delete account" (AccountPage.tsx / AUTH_DELETE_ACCOUNT), a regression of v3.2 Task 8's own DoD
-- ("permanently deletes your account and every record tied to it"). Fixed by re-declaring the
-- function (create or replace - same technique 20260815000029_v2_nudges_require_shared_group.sql
-- uses to amend an existing SECURITY DEFINER function in a later migration) with one added
-- statement, grouped alongside the other simple single-owner-column tables (profiles has no other
-- table referencing it, so it carries no dependency-ordering constraint of its own - it can be
-- deleted at any point in this function, same as nudges/daily_digests/coaching_message_requests/
-- session_status_events already are). Every other line below is copied verbatim from
-- 20260815000032 - only the one new `delete from profiles ...` statement is added.
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

  -- v3.3 Task 8 follow-up (this migration): profiles.user_id references auth.users(id) with no
  -- ON DELETE CASCADE, same as every other table in this function - must go before Step 3's
  -- auth.users delete, or that delete fails outright. No other table references profiles, so this
  -- has no ordering dependency of its own.
  delete from profiles where user_id = p_user_id;

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
