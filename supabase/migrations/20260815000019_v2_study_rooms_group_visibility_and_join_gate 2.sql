-- v2 Task 13: Study Rooms - closes the RLS gap Task 5's own migration (20260815000002)
-- deliberately left conservative, pending this task: "the plan doesn't give an explicit RLS
-- guarantee for these two (Task 13 owns the feature). Conservative default ... owner and current
-- participants only - so nothing is over-exposed before Task 13 defines real access rules." This
-- is that definition, and it's a proactive, necessary correction, not scope creep - this project
-- has hit the identical bug class (widen read, forget to also gate write, or vice versa) on
-- unlock_requests (20260815000008), daily_digests (20260815000011), friendship_settings
-- (20260815000013), and temp_passcode_requests (20260815000017 then AGAIN in 20260815000018 for
-- the other DML verb) - so both halves are fixed together here, in one migration, from the start.
--
-- Problem 1 (discovery gap, identical chicken-and-egg shape to unlock_requests' pre-Task-8 gap):
-- study_rooms' original SELECT policy ("owner and participants can read study rooms") only allows
-- the owner or an ALREADY-JOINED participant to see a room. A group-mate who hasn't joined yet has
-- no way to discover the room exists at all - but this task's own DoD requires "two test accounts
-- in the same friend group can create/join the same room," which needs the non-owner to be able
-- to find the room before they can join it.
--
-- Fix: widen SELECT to also include any user who shares a group_memberships group with the room's
-- owner_user_id, via users_share_a_group(uuid, uuid) - the reusable two-user "do these people
-- currently share ANY group" SECURITY DEFINER helper Task 10 (20260815000012) already defined
-- (and friendship_settings' own INSERT policy, 20260815000013, already reuses) rather than
-- reintroducing a raw double-self-join here. No additional per-friendship consent gate is layered
-- on top (unlike session_status_events'/daily_digests' friend_has_granted_*_visibility checks) -
-- the brief's access model for a Study Room is plain group membership, nothing finer-grained.
drop policy "owner and participants can read study rooms" on study_rooms;

create policy "owner group-mates and participants can read study rooms"
  on study_rooms for select
  using (
    owner_user_id = auth.uid()
    or users_share_a_group(owner_user_id, auth.uid())
    or exists (
      select 1 from study_room_participants srp
      where srp.room_id = study_rooms.id and srp.user_id = auth.uid()
    )
  );

-- Problem 2 (unrestricted join gap, identical shape to friendship_settings'/group_memberships'
-- pre-fix INSERT gaps): study_room_participants' original INSERT policy ("users can insert their
-- own participant row") only ever checked user_id = auth.uid() - NO group-membership requirement
-- at all. Rooms are not secret UUIDs guarded by anything else, and Problem 1's SELECT widening
-- above makes them actively discoverable to group-mates - so without this fix, ANY authenticated
-- stranger who learns/guesses a room_id could self-insert as a participant in ANY room, group
-- membership or not. This is the write-side half of the fix; skipping it while only widening
-- SELECT is exactly the kind of incomplete fix this project's own history (Task 12's two fix
-- rounds) shows leads to a second Critical-severity round.
--
-- Fix: require the inserting user to either BE the room's owner (so an owner can always join
-- their own room even in the edge case where they don't currently belong to ANY group themselves
-- - users_share_a_group(x, x) only returns true if x has at least one group_memberships row to
-- self-join against, so this explicit owner clause is not redundant with the group check) OR
-- share a group with the room's owner_user_id - looked up via a subquery into study_rooms, since
-- study_room_participants itself carries no owner column of its own.
drop policy "users can insert their own participant row" on study_room_participants;

create policy "users can insert their own participant row for a discoverable room"
  on study_room_participants for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from study_rooms sr
      where sr.id = study_room_participants.room_id
        and (sr.owner_user_id = auth.uid() or users_share_a_group(sr.owner_user_id, auth.uid()))
    )
  );

-- Realtime: the first table in this codebase to use Supabase Realtime's Postgres Changes feature
-- (grepped: no prior `alter publication supabase_realtime add table ...` anywhere in
-- supabase/migrations, no `.channel()`/`postgres_changes` usage anywhere in src/). Postgres
-- Changes events for a table are authorized using that table's own RLS SELECT policy - not a
-- separate mechanism - so a subscriber only ever receives change events for rows they could
-- otherwise SELECT directly. study_room_participants' SELECT policy ("participants and owner can
-- read room participant rows", from 20260815000002, left UNCHANGED by this migration) already
-- requires the subscriber to already be a participant (or the room's owner) before they can read
-- ANY row for that room - which is correct and sufficient for presence: subscribeToPresence is
-- only ever called after joinRoom has already inserted the caller's own participant row (see
-- infrastructure/backend/studyRoomApi.ts), at which point that self-row satisfies the existing
-- policy's own self-referential EXISTS check for every other row in the same room. Problem 1/2
-- above are about DISCOVERING and JOINING a room before that point - not about watching a room's
-- presence before joining it, which nothing in this task's brief or DoD asks for.
alter publication supabase_realtime add table study_room_participants;
