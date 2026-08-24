-- v3.2 Task 8: Account/data deletion.
--
-- Verified against the REAL current schema before writing this (not the plan's own table list,
-- which this migration's header documents a correction to): grepped every `create table` across
-- supabase/migrations/*.sql. The complete set of tables with a column referencing auth.users(id)
-- is: friend_groups, group_memberships, invite_codes, friendship_settings, session_status_events,
-- unlock_requests, temp_passcode_requests, study_rooms, study_room_participants, producer_tags,
-- producer_tag_sends, daily_digests, nudges (20260815000007), coaching_message_requests
-- (20260815000014). The plan's own Task 8 deliverable text names twelve of these but omits the
-- last two (`nudges`, `coaching_message_requests`) - both were added by later v2 tasks, after the
-- plan's given list was presumably drafted against the Task 5 schema block alone. This migration
-- covers all fourteen, not just the plan's literal twelve - "every row referencing the caller's
-- auth.uid()" is the actual DoD language, and these two tables genuinely have such rows.
--
-- Also verified: no FK anywhere in this schema has `on delete cascade` (grepped every
-- `references`/`on delete` across every migration - zero hits for `on delete cascade`, `on delete
-- set null`, etc.). Every FK is the Postgres default (NO ACTION/RESTRICT). This means deleting
-- auth.users' row alone would NOT cascade-clean anything - every referencing row must be removed
-- (or, where the schema allows, have its reference nulled out) explicitly, in FK-safe dependency
-- order, before auth.users' own row can go. That ordering is this function's entire job.
--
-- === Ownership: friend_groups / study_rooms (the plan's own flagged judgment call) ===
--
-- friend_groups.owner_user_id and study_rooms.owner_user_id are both `not null references
-- auth.users(id)` with no ownership-transfer mechanism anywhere in this schema (confirmed by
-- grepping every migration for `owner_user_id` - the only precedent is 20260815000028's
-- group-leave migration, which explicitly documents "there is no ownership-transfer mechanism
-- anywhere in this schema" and accepts a departed owner's `owner_user_id` staying stale-but-valid,
-- since in that case the referenced auth.users row still exists - it's just no longer a member).
-- Account deletion is a materially different situation: the referenced auth.users row is about to
-- stop existing entirely, so a stale owner_user_id is no longer just semantically odd, it would be
-- a dangling FK reference that Postgres will not allow the parent row to be deleted while it
-- exists. Two different, deliberately different, resolutions:
--
--   - friend_groups: a friend group is this schema's persistent, ongoing social structure (real
--     owner-only privileges: kicking members via is_group_owner(), generating invite codes -
--     things other CURRENT members plausibly still want to use). If other members remain,
--     ownership is reassigned to the longest-standing remaining member (earliest joined_at) rather
--     than destroying the group out from under them - the group and its history survive the
--     owner's departure, matching this schema's own established "the group outlives any single
--     membership change" stance from 20260815000028. Only when the deleting user is the group's
--     LAST member does the group (and its invite_codes) get deleted outright - there is no one
--     left for it to belong to.
--   - study_rooms: a study room has no client-facing UPDATE or DELETE policy at all (confirmed by
--     grepping every `for update`/`for delete` policy naming study_rooms - none exist), meaning
--     there is no existing "close a room" concept and no precedent for treating owner_user_id as
--     anything other than immutable provenance for an ephemeral LiveKit video-call session, unlike
--     friend_groups' ongoing invite/kick privileges. Reassigning ownership of a defunct call session
--     to another former participant has no product meaning. So: cascade-delete study_rooms owned
--     by the deleting user outright (dropping every participant's join/leave history for that one
--     room, and nulling - not deleting - any producer_tag_sends row that pointed a Producer Tag
--     into it, preserving that send's own history). Bounded, single-room blast radius, not the
--     open-ended multi-day social history a friend_group represents.
--
-- === Storage cleanup ===
--
-- Producer Tag audio lives in the `producer-tags` Storage bucket at the exact path stored in
-- producer_tags.audio_url (confirmed by reading uploadTag() in
-- snufflestudy/src/infrastructure/backend/producerTagApi.ts - `${tagId}/clip.webm`, uploaded via
-- `supabase.storage.from("producer-tags").upload(path, ...)`). This function returns the
-- audio_url list for every producer_tags row it deletes (read BEFORE the delete, in the same
-- statement via a CTE) so the caller (the delete-account Edge Function, which has access to the
-- Storage API this plain SQL function does not) can remove the actual Storage objects. Deleting
-- storage.objects rows directly via SQL from inside this function was deliberately rejected -
-- Supabase's Storage backend keeps object bytes in a separate backing store (S3-compatible);
-- removing only the storage.objects metadata row via raw SQL does not reliably delete the backing
-- bytes, only the Storage HTTP API's own DELETE (used by the Edge Function next to this migration)
-- does that correctly. This function's job stops at "tell the caller which paths to remove."
--
-- === Who may call this ===
--
-- Granted to service_role only, NEVER to authenticated - it takes an explicit p_user_id
-- parameter, so if `authenticated` could call it directly, any signed-in user could pass someone
-- else's id and delete their account. The actual self-service guarantee ("callable only by the
-- authenticated user themselves") is enforced one layer up, by the delete-account Edge Function
-- (supabase/functions/delete-account/index.ts), which derives p_user_id exclusively from the
-- caller's own verified JWT (via anonClient.auth.getUser(jwt), the same pattern
-- generate-livekit-token/generate-coaching-message already use) and never accepts a client-
-- supplied target id in its request body at all. This mirrors this schema's existing convention
-- for privileged, parameterized write functions (compute_daily_digests, can_send_nudge) being
-- service_role/definer-gated rather than directly authenticated-callable.
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

  -- === study_rooms owned by the caller: cascade (see header comment for why this, unlike
  -- friend_groups, is a full cascade rather than an ownership reassignment) ===
  update producer_tag_sends
     set recipient_room_id = null
   where recipient_room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_room_participants
   where room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_rooms where owner_user_id = p_user_id;

  -- === friend_groups owned by the caller: reassign to the longest-standing remaining member if
  -- one exists (see header comment); otherwise left for the "last member" branch below to catch
  -- once the caller's own membership row is gone ===
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

revoke all on function public.delete_account_data(uuid) from public;
grant execute on function public.delete_account_data(uuid) to service_role;
