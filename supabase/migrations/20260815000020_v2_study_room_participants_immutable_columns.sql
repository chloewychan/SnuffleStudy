-- v2 Task 13 fix round 1 (Critical, code review): closes an UPDATE-path bypass of the INSERT/
-- SELECT fix migration 20260815000019 just landed, in the exact same "fixed one route, missed
-- another" shape this project has hit twice before (Task 8's unlock_requests immutable-columns
-- trigger, 20260815000009; Task 12's two-round INSERT/UPDATE bypass on temp_passcode_requests,
-- 20260815000017/20260815000018).
--
-- Bug: study_room_participants' original UPDATE policy (20260815000002, "users can update their
-- own participant row") is `using (user_id = auth.uid()) with check (user_id = auth.uid())` -
-- it constrains WHO the row belongs to, but says nothing about `room_id` (or `user_id`/
-- `joined_at`, the other two components of the composite primary key). 20260815000019's INSERT
-- fix correctly gates WHICH room a user can insert a fresh participant row for, and its SELECT
-- fix correctly gates WHICH rooms a user can discover - but neither touches UPDATE, and UPDATE
-- alone is enough to defeat both:
--
--   1. Any authenticated user (zero shared groups anywhere) creates a room they own - study_rooms'
--      INSERT policy only ever checked owner_user_id = auth.uid(), by design (no group
--      prerequisite to CREATE a room, only to join someone else's).
--   2. That user inserts themselves as a participant of their OWN room, via the
--      `sr.owner_user_id = auth.uid()` clause 20260815000019's INSERT policy correctly allows -
--      a legitimate row (room_id = R_attacker, user_id = self).
--   3. `update study_room_participants set room_id = '<target-room>' where room_id = R_attacker
--      and user_id = self` - passes USING (user_id = auth.uid(), unchanged) and WITH CHECK
--      (user_id = auth.uid(), still true post-update since user_id itself wasn't touched).
--      Neither clause ever inspects room_id, so retargeting it to an arbitrary room the attacker
--      shares no group with - and never had a legitimate INSERT path into - succeeds outright.
--
-- Impact confirmed by reading generate-livekit-token/index.ts: it authorizes purely by finding a
-- matching study_room_participants row via the service-role client (which bypasses RLS, so it
-- trusts the row's mere existence as proof of legitimate membership - correct ONLY because RLS
-- was supposed to guarantee that row could never exist without a real group relationship). The
-- retargeted row from step 3 satisfies that lookup, handing the attacker a real, validly-scoped
-- LiveKit token for the target room with zero group relationship ever checked against its owner.
-- It also silently restores the attacker's SELECT visibility into the target room (both SELECT
-- policies key off "is a participant of this room"), defeating the discovery-gap fix too, not
-- just the join gate.
--
-- Fix: same remedy already established in this codebase for the identical shape (unlock_requests'
-- immutable-columns trigger, 20260815000009) - a BEFORE UPDATE trigger, not a wider WITH CHECK.
-- A plain WITH CHECK can only inspect the proposed NEW row in isolation; it has no way to diff NEW
-- against OLD, so it cannot express "this column must not change" (only "this column must hold
-- some particular value"). The trigger runs with access to both OLD and NEW and aborts the whole
-- statement if any of the three composite-primary-key columns (room_id, user_id, joined_at)
-- differ - independent of which RLS policy authorized the UPDATE attempt in the first place. This
-- leaves left_at as the only column any UPDATE may ever change, which is exactly and exhaustively
-- what studyRoomApi.ts's leaveRoom() does (`update({ left_at }).eq("room_id", ...).eq("user_id",
-- ...).is("left_at", null)` - never touches room_id/user_id/joined_at), so no legitimate client
-- code path is affected by this tightening.
create or replace function study_room_participants_prevent_immutable_column_changes()
returns trigger
language plpgsql
as $$
begin
  if new.room_id <> old.room_id
    or new.user_id <> old.user_id
    or new.joined_at <> old.joined_at
  then
    raise exception 'room_id, user_id, and joined_at cannot be changed on a study room participant row';
  end if;
  return new;
end;
$$;

create trigger study_room_participants_immutable_columns
  before update on study_room_participants
  for each row
  execute function study_room_participants_prevent_immutable_column_changes();
