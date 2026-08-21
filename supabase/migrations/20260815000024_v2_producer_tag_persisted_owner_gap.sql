-- v2 Task 14 fix round 2 (Important): closes the persisted-data half of the same owner-equivalence
-- gap 20260815000023 closed for the broadcast layer.
--
-- 20260815000023 added an owner-of-study_rooms branch to BOTH realtime.messages Broadcast
-- policies (SEND and RECEIVE), so a room owner who never joined their own room (no
-- study_room_participants row) can send AND receive producer-tag broadcasts for that room - matching
-- Part A.2's own producer_tag_sends INSERT floor, which already treats "owner OR participant" as
-- equivalent for targeting a room.
--
-- But review found that fix was asymmetric: the three PERSISTED-DATA surfaces that actually gate
-- what a recipient can DO with a received broadcast were never given the same owner-equivalence
-- branch, and still require genuine study_room_participants membership:
--   - producer_tags "recipients can read tags sent to them" (20260815000002:197-209)
--   - producer_tag_sends "sender recipient or room member can read sends" (20260815000002:213-225)
--   - storage.objects "producer tag owner or authorized recipient can read tag audio"
--     (20260815000021:183-207)
--
-- Concrete scenario the review raised: room R1 owned by A, who never joins. B is a genuine
-- participant and sends a tag to R1. If A independently holds a live subscription to the broadcast
-- topic (reachable by any client using the same Supabase auth session directly, not just the shipped
-- extension UI - exactly the class of access RLS is meant to be the real boundary against), A
-- receives the broadcast payload (sender identity + timestamp) but then fetchProducerTagById returns
-- null (RLS-filtered) and downloadTagAudio is denied - A learns metadata about their own room's
-- traffic that none of the persisted-data policies would otherwise show them. This contradicts Part
-- D's own stated design invariant (20260815000021's header comment): "storage/broadcast access must
-- mirror the relational RLS, not diverge from it in either direction" - the mirror was only built in
-- one direction.
--
-- Fix: add the same `sr.owner_user_id = auth.uid()` branch (already used in Part A.2 of
-- 20260815000021 and in 20260815000023) to all three persisted-data SELECT policies below, so a room
-- owner has exactly the same read access as a genuine participant would for tags sent to their room -
-- owner-equivalence is now consistent everywhere room-tag access is gated, not just at the broadcast
-- layer. This is the same "one route fixed, structurally-identical sibling route left narrower" shape
-- this project has hit repeatedly (Tasks 8, 9, 10, 12 (twice), 13, and 14's own fix round 1) - this is
-- instance eight, closed here rather than left for a future round.

-- =============================================================================================
-- producer_tags: "recipients can read tags sent to them" gains the owner branch, nested under the
-- same producer_tag_sends join the existing participant check already uses (the room-id column
-- here is only reachable via pts.recipient_room_id, so the owner check must sit inside that same
-- exists() rather than as a sibling top-level clause).
drop policy "recipients can read tags sent to them" on producer_tags;

create policy "recipients can read tags sent to them"
  on producer_tags for select
  using (exists (
    select 1 from producer_tag_sends pts
    where pts.tag_id = producer_tags.id
      and (
        pts.recipient_user_id = auth.uid()
        or exists (
          select 1 from study_room_participants srp
          where srp.room_id = pts.recipient_room_id and srp.user_id = auth.uid()
        )
        or exists (
          select 1 from study_rooms sr
          where sr.id = pts.recipient_room_id and sr.owner_user_id = auth.uid()
        )
      )
  ));

-- =============================================================================================
-- producer_tag_sends: "sender recipient or room member can read sends" gains the same owner
-- branch, alongside the existing recipient_room_id participant check.
drop policy "sender recipient or room member can read sends" on producer_tag_sends;

create policy "sender recipient or room member can read sends"
  on producer_tag_sends for select
  using (
    sender_user_id = auth.uid()
    or recipient_user_id = auth.uid()
    or (
      recipient_room_id is not null
      and exists (
        select 1 from study_room_participants srp
        where srp.room_id = producer_tag_sends.recipient_room_id and srp.user_id = auth.uid()
      )
    )
    or (
      recipient_room_id is not null
      and exists (
        select 1 from study_rooms sr
        where sr.id = producer_tag_sends.recipient_room_id and sr.owner_user_id = auth.uid()
      )
    )
  );

-- =============================================================================================
-- storage.objects: "producer tag owner or authorized recipient can read tag audio" gains the same
-- owner branch, nested the same way as producer_tags' fix above (the room-id column is only
-- reachable via pts.recipient_room_id inside the existing producer_tag_sends join).
drop policy "producer tag owner or authorized recipient can read tag audio" on storage.objects;

create policy "producer tag owner or authorized recipient can read tag audio"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'producer-tags'
    and exists (
      select 1 from producer_tags pt
      where pt.id::text = (storage.foldername(name))[1]
        and (
          pt.user_id = auth.uid()
          or exists (
            select 1 from producer_tag_sends pts
            where pts.tag_id = pt.id
              and (
                pts.recipient_user_id = auth.uid()
                or exists (
                  select 1 from study_room_participants srp
                  where srp.room_id = pts.recipient_room_id and srp.user_id = auth.uid()
                )
                or exists (
                  select 1 from study_rooms sr
                  where sr.id = pts.recipient_room_id and sr.owner_user_id = auth.uid()
                )
              )
          )
        )
    )
  );
