-- v2 final whole-branch review, Important finding I2 (server half): temp_passcode_requests was the
-- only cross-user-targeting write in this schema with no shared-group floor.
--
-- Task 12's fix round 2 (20260815000018:41-64) tightened the INSERT policy substantially - it now
-- checks requester_user_id = auth.uid(), pins every approval-implying column to its
-- genuinely-pending value, and requires requester_user_id <> friend_user_id. What it never checked
-- is that requester_user_id and friend_user_id have any relationship at all. Every other write in
-- this schema that names ANOTHER user in a column has that floor:
--
--   producer_tag_sends   INSERT -> users_share_a_group(sender_user_id, recipient_user_id)   (20260815000021:105-108)
--   friendship_settings  INSERT -> users_share_a_group(user_id, friend_user_id)             (20260815000013:56-61)
--   study_room_participants INSERT -> shared group with the room owner                      (20260815000019:56-65)
--
-- temp_passcode_requests was the sole exception, so any authenticated user who learns another
-- user's UUID could create a request naming that stranger as friend_user_id. Learning a UUID is
-- not a meaningful barrier: group_memberships exposes every co-member's id to any member of a
-- shared group, and before this review's Critical finding C1 was closed
-- (20260815000025_v2_lock_down_invite_code_redemption.sql) an attacker could enumerate invite
-- codes and join an arbitrary group to harvest ids wholesale.
--
-- Impact is not merely a junk row: the row is immediately readable by the named stranger (Task 5's
-- "requester or assigned friend can read temp passcode requests" policy), it surfaces in their
-- side panel via alarmHandlers.ts's friend-poll alarm, and - the reason this is Important rather
-- than Minor - send-temp-passcode-request emails that stranger's REAL email address with the
-- request's caller-controlled `hostname` interpolated into the message body. The client half of
-- this finding (HTML-escaping that interpolation, which was previously raw) is fixed in
-- supabase/functions/send-temp-passcode-request/index.ts in the same commit as this migration.
-- This migration is the other half: cutting off the ability to target a stranger at all.
--
-- Fix: add the same users_share_a_group() floor every sibling table already has. Reuses the
-- existing helper from 20260815000012 rather than reinventing the double-self-join inline. Drop +
-- recreate is the established pattern for policy changes in this project (Postgres has no
-- `alter policy ... with check`-only-append form, and every prior fix-round migration here does
-- the same).
--
-- No client-code change is needed: LockedPage.tsx's friend picker is already populated from the
-- current user's own group memberships, so every request the real UI can produce already satisfies
-- this floor. Only rows that were never legitimate to begin with are newly rejected - the same
-- shape of tightening 20260815000018 itself was.
drop policy "users can create their own genuinely-pending temp passcode requests"
  on temp_passcode_requests;

create policy "users can create their own genuinely-pending temp passcode requests"
  on temp_passcode_requests for insert
  with check (
    requester_user_id = auth.uid()
    -- Unchanged from 20260815000018 - a request cannot start pre-approved, or carrying any value
    -- only approve-temp-passcode should ever set.
    and status = 'pending'
    and code_hash is null
    and code_salt is null
    and failed_attempts = 0
    and locked_until is null
    and expires_at is null
    -- Unchanged from 20260815000018 - a requester cannot name themselves as the approving friend
    -- and self-approve through the legitimate approve-temp-passcode path.
    and requester_user_id <> friend_user_id
    -- The new floor (final review, finding I2): the assigned friend must actually be someone this
    -- requester shares a group with. Without it, any authenticated user who knows a stranger's
    -- UUID could put that stranger's real email address on the receiving end of an
    -- attacker-authored notification.
    and users_share_a_group(requester_user_id, friend_user_id)
  );
