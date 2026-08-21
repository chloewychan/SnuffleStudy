-- v2 Task 10 fix round 1: closes the friendship_settings INSERT gap flagged (and deferred) twice
-- before this migration - first by 20260815000011's comment ("worth tightening at the source ...
-- as part of Task 10's privacy-controls work"), then again by Task 10's own first pass, which
-- left it open on the belief that the brief scoped Part A's CRUD surface to "no new RLS for the
-- CRUD itself." On review, that quoted phrase does not appear anywhere in the actual brief or
-- plan - the stated justification did not hold up. This migration closes the gap instead of
-- deferring it a third time.
--
-- Bug (unchanged since 20260815000002/20260815000011's original description): friendship_settings'
-- "users manage only their own settings rows" policy is `for all` with only `user_id = auth.uid()`
-- - it places zero restriction on `friend_user_id`, so any authenticated user can INSERT a row
-- naming an arbitrary stranger they've never shared a group with. Every consumer built since
-- (can_send_nudge, friend_has_granted_live_visibility, friend_has_granted_digest_visibility, and
-- this task's five new friend_has_granted_*_visibility helpers) already independently re-adds a
-- group-membership floor on the READ side - but the WRITE side (creating the row in the first
-- place) never required one, which is the actual, still-open gap.
--
-- Why this is safe to close now, and wasn't before: migration 20260815000012 (this task's own
-- first pass) added a trigger that auto-creates BOTH directions of a friendship_settings row for
-- every pair of users the instant they share a group - see
-- create_friendship_settings_for_new_member(). That trigger changes the calculus completely:
-- - friendshipSettingsApi.ts's updateFriendshipSettings() is UPDATE-only by design (its own
--   comment: "by the time a user can see a friend to configure settings for at all ... the row
--   already exists") - it never calls INSERT.
-- - FriendsPage.tsx (the only UI consumer) never exercises INSERT either.
-- - The trigger itself bypasses this policy entirely (SECURITY DEFINER, runs as the owning role -
--   see 20260815000012's header comment) - tightening the client-facing INSERT policy does not
--   affect the trigger's own writes at all.
-- So there is no longer any legitimate, in-product path that needs an unrestricted client-side
-- INSERT - the only remaining consumer of the old, looser policy was scripts/verify-nudges.mjs's
-- test setup (which never created a shared group for its two accounts), fixed in the same commit
-- as this migration to set up a shared group first, mirroring how verify-rls.mjs/
-- verify-friend-sync.mjs/verify-digest.mjs already had to adapt to the new trigger's behavior.
--
-- Fix: split the `for all` policy into its unchanged SELECT/UPDATE/DELETE half (still just
-- `user_id = auth.uid()` - a user's unrestricted control over their OWN rows is untouched) and a
-- separate, tighter INSERT policy that additionally requires users_share_a_group(user_id,
-- friend_user_id) - reusing the exact helper 20260815000012 already defined, rather than
-- reintroducing a raw double-self-join here.

drop policy "users manage only their own settings rows" on friendship_settings;

create policy "users can read their own settings rows"
  on friendship_settings for select
  using (user_id = auth.uid());

create policy "users can update their own settings rows"
  on friendship_settings for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users can delete their own settings rows"
  on friendship_settings for delete
  using (user_id = auth.uid());

create policy "users can insert their own settings rows only toward a shared-group friend"
  on friendship_settings for insert
  with check (
    user_id = auth.uid()
    and users_share_a_group(user_id, friend_user_id)
  );

-- Minor documentation fix (reviewer-flagged, not a behavior change): clarifies, via a real
-- queryable Postgres COMMENT rather than editing the already-applied 20260815000012's file body
-- (this schema's established convention - fix rounds are new migrations, never edits to
-- previously-applied ones), that fetch_friend_full_history and fetch_friend_intervention_count
-- deliberately do NOT require friend_has_granted_live_visibility (the baseline "active/completed
-- status" gate every OTHER read path in this schema checks first). This is intentional, not an
-- oversight: docs/Draft1_Architecture_Overview.md's "Privacy controls" list presents "full session
-- history" and "number of interventions" as independent visibility axes a session owner can grant
-- separately from baseline status visibility (e.g. a user could opt a friend into their
-- intervention count/full history for accountability purposes without ever turning on live
-- status/nudge visibility at all) - each function's own group-membership-floor +
-- share_full_history/share_intervention_count check is a complete, self-sufficient gate on its
-- own, exactly like every other friend_has_granted_*_visibility helper in this file.
comment on function public.fetch_friend_full_history(uuid) is
  'v2 Task 10: deliberately does NOT require friend_has_granted_live_visibility (the baseline gate) - full session history is its own independent privacy axis (share_full_history + group floor is a complete gate on its own), not additive on top of baseline live visibility. See this migration''s header comment.';

comment on function public.fetch_friend_intervention_count(uuid, timestamptz) is
  'v2 Task 10: deliberately does NOT require friend_has_granted_live_visibility (the baseline gate) - intervention count is its own independent privacy axis (share_intervention_count + group floor is a complete gate on its own), not additive on top of baseline live visibility. See this migration''s header comment.';
