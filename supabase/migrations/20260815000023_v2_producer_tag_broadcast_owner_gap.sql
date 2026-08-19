-- v2 Task 14 fix round 1 (continued): fixes a second real bug surfaced by actually running
-- scripts/verify-producer-tags.mjs against the live project after 20260815000022's recursion fix
-- (31 of 32 checks passed; only "Case 3: D's live subscription received the producer-tag broadcast
-- within 10s" still failed).
--
-- Root cause: 20260815000021's Part D realtime.messages policies ("producer tag room members can
-- send broadcasts" / "...can receive broadcasts") only check study_room_participants:
--
--   exists (select 1 from study_room_participants srp
--           where realtime.topic() = 'study-room-producer-tags:' || srp.room_id::text
--             and srp.user_id = auth.uid())
--
-- But that SAME migration's Part A.2 (the producer_tag_sends INSERT floor, governing "who may
-- target this room with a producer tag send" - the exact sibling permission Part D's broadcast
-- authorization exists to carry live) deliberately treats a room's OWNER as equivalent to a
-- participant for this purpose:
--
--   sr.owner_user_id = auth.uid()
--   or exists (select 1 from study_room_participants srp where srp.room_id = sr.id and srp.user_id = auth.uid())
--
-- study_rooms' own SELECT policy (20260815000003) and every other room-scoped policy in this
-- codebase apply the same owner-or-participant floor. Nothing in this codebase auto-adds a room's
-- owner to study_room_participants when they create it (studyRoomApi.ts's createRoom() inserts
-- only the study_rooms row; a user - including the owner - only gets a study_room_participants row
-- by separately calling joinRoom()) - so a room owner who sends a producer tag into their OWN room
-- before ever joining it (explicitly permitted by Part A.2's owner branch) would have their
-- producer_tag_sends row created successfully, but producerTagApi.ts's own follow-up
-- broadcastProducerTagToRoom() call would be silently rejected by Part D's SEND policy (caught by
-- sendToRoom()'s deliberate best-effort try/catch, so the failure never surfaces to the user - it
-- would just look like the broadcast never happened). That's the identical "one route granted a
-- floor comprehensively, a structurally-identical sibling route left narrower" shape this project
-- has hit repeatedly (Tasks 8, 9, 10, 12 (twice), 13) - here within a single migration instead of
-- across two.
--
-- Fix: both realtime.messages policies gain the same owner branch Part A.2 already has, so
-- broadcast SEND/RECEIVE authorization matches producer_tag_sends' own INSERT floor exactly
-- (Part D's own header comment already states this is the intended invariant: "storage/broadcast
-- access must mirror the relational RLS, not diverge from it in either direction" - this was a gap
-- against that stated intent, not a deliberate narrowing).
drop policy "producer tag room members can send broadcasts" on realtime.messages;

create policy "producer tag room members can send broadcasts"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and (
      exists (
        select 1 from study_room_participants srp
        where realtime.topic() = 'study-room-producer-tags:' || srp.room_id::text
          and srp.user_id = auth.uid()
      )
      or exists (
        select 1 from study_rooms sr
        where realtime.topic() = 'study-room-producer-tags:' || sr.id::text
          and sr.owner_user_id = auth.uid()
      )
    )
  );

drop policy "producer tag room members can receive broadcasts" on realtime.messages;

create policy "producer tag room members can receive broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (
      exists (
        select 1 from study_room_participants srp
        where realtime.topic() = 'study-room-producer-tags:' || srp.room_id::text
          and srp.user_id = auth.uid()
      )
      or exists (
        select 1 from study_rooms sr
        where realtime.topic() = 'study-room-producer-tags:' || sr.id::text
          and sr.owner_user_id = auth.uid()
      )
    )
  );
