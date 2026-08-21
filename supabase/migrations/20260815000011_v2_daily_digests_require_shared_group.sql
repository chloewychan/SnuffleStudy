-- v2 Task 9 fix round 1: closes a real privacy gap found in code review.
--
-- Bug: daily_digests' original SELECT policy (20260815000010, migration not edited here since
-- it's already applied - this is a corrective follow-up, same convention as
-- 20260815000003/000004/000005/000006/000008/000009's fix-round pattern) required only
-- friend_has_granted_digest_visibility(...) - the viewer's own friendship_settings row - with no
-- group-membership floor at all. Every other cross-user visibility check in this schema requires
-- BOTH a shared group_memberships row AND some consent gate:
--   - session_status_events (20260815000006): shared group AND the subject's own
--     send_live_nudges=true toward the viewer.
--   - unlock_requests (20260815000008): shared group (while pending).
-- daily_digests skipped the group-membership half entirely. Combined with friendship_settings'
-- own INSERT policy (20260815000002) placing zero restriction on friend_user_id, any
-- authenticated user could insert a friendship_settings row targeting an arbitrary stranger's
-- user id and immediately read that stranger's full daily digest (session counts, distraction
-- counts, recovery rate) - with zero involvement from the subject and no group relationship at
-- all. Confirmed live: the original scripts/verify-digest.mjs's positive cases never created a
-- friend_groups/group_memberships row for either party, and the read still succeeded - exactly
-- the gap being exercised (accidentally) by that script's own setup. This directly contradicts
-- docs/Draft1_Architecture_Overview.md's "Privacy controls" section ("the session owner should
-- choose whether friends can see... default should be minimal visibility").
--
-- Fix: add the identical group-membership check session_status_events' policy uses (a raw
-- double-self-join on group_memberships, not routed through a SECURITY DEFINER helper - this
-- exact shape is already proven live via scripts/verify-friend-sync.mjs and
-- scripts/verify-unlock-requests.mjs to work without the recursion 20260815000003/20260815000006
-- had to fix for OTHER policy shapes) as an additional AND condition alongside
-- friend_has_granted_digest_visibility(...). The full gate is now: viewer and subject share a
-- group membership, AND the viewer has opted in via their own receive_daily_digest row. Neither
-- condition alone is sufficient, matching session_status_events' precedent exactly.
--
-- Flagged but explicitly NOT fixed here (broader, pre-existing Task 5 design point flagged for
-- Task 10's attention, per code review - not this migration's scope): friendship_settings' own
-- INSERT policy (20260815000002, "users manage only their own settings rows") still lets any
-- authenticated user write a row naming an arbitrary friend_user_id, with no group-membership
-- check on the INSERT itself. This migration closes the daily_digests READ side of the resulting
-- exposure (a stranger's opt-in row alone can no longer surface real digest data without a shared
-- group), but the same unrestricted INSERT still lets a stranger silently accumulate
-- friendship_settings rows about people they've never grouped with. That's harmless to
-- daily_digests specifically now that this migration adds a group-membership floor here, but the
-- same gap could still matter to some other, not-yet-built consumer of friendship_settings that
-- doesn't independently enforce its own group check - worth tightening at the source (the INSERT
-- policy itself) as part of Task 10's privacy-controls work, not patched piecemeal per consumer
-- table here.

drop policy "subject or digest-opted-in friend can read a daily digest" on daily_digests;

create policy "subject or digest-opted-in group-mate can read a daily digest"
  on daily_digests for select
  using (
    subject_user_id = auth.uid()
    or (
      exists (
        select 1 from group_memberships gm_self
        join group_memberships gm_subject on gm_subject.group_id = gm_self.group_id
        where gm_self.user_id = auth.uid()
          and gm_subject.user_id = daily_digests.subject_user_id
      )
      and friend_has_granted_digest_visibility(daily_digests.subject_user_id, auth.uid())
    )
  );
