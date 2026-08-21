-- v2 Task 14: Producer Tags (Audio Nudges) - Supabase Storage (first use in this codebase),
-- Realtime Broadcast authorization (first use of Broadcast in this codebase - Task 13's
-- subscribeToPresence used Postgres Changes, a different mechanism), and two proactive RLS
-- tightenings on the existing producer_tags/producer_tag_sends tables surfaced by this task's own
-- "verify thoroughly, don't assume no policy = safely denied" instruction.
--
-- Everything below was applied in ONE pass, from the start of this task, not as a later fix
-- round - per this task's brief: "Read supabase/migrations/*.sql before writing SQL - especially
-- the group-membership-floor pattern and the immutable-columns trigger pattern (20260815000009,
-- 20260815000020), both of which this task's design should apply proactively rather than needing
-- a fix round to add later (this project has hit this exact class of bug in Tasks 8, 9, 10, 12
-- (twice), and 13 - do not add a sixth instance)."

-- =============================================================================================
-- Part A.1: producer_tags immutable-columns trigger (the "instance six" this task's brief warns
-- against, applied proactively here instead).
--
-- producer_tags' owner-side "for all" policy (20260815000002) grants the owner unrestricted
-- UPDATE on their own tag - including AFTER it's already been sent to a friend or room via
-- producer_tag_sends. Since audio_url encodes the tag's own Storage object path (Part B's SELECT
-- policy below is keyed off it), an owner could otherwise rewrite audio_url to point at a
-- DIFFERENT tag's audio they also own but never actually sent, silently swapping what an
-- already-authorized recipient hears without redoing any send/authorization step - the same
-- "fixed one route, missed another" shape as unlock_requests' pre-20260815000009 gap and
-- study_room_participants' pre-20260815000020 gap. producerTagApi.ts's uploadTag() only ever
-- INSERTs a producer_tags row once (never updates one) - nothing in this task's real client flow
-- needs any of these four columns to change after creation, so all four are pinned.
create or replace function producer_tags_prevent_immutable_column_changes()
returns trigger
language plpgsql
as $$
begin
  if new.user_id <> old.user_id
    or new.audio_url <> old.audio_url
    or new.duration_ms <> old.duration_ms
    or new.created_at <> old.created_at
  then
    raise exception 'user_id, audio_url, duration_ms, and created_at cannot be changed on a producer tag';
  end if;
  return new;
end;
$$;

create trigger producer_tags_immutable_columns
  before update on producer_tags
  for each row
  execute function producer_tags_prevent_immutable_column_changes();

-- =============================================================================================
-- Part A.2: producer_tag_sends INSERT floor (the group-membership-floor pattern, applied
-- proactively).
--
-- The original policy (20260815000002) is `with check (sender_user_id = auth.uid())` - and
-- NOTHING else. Three real gaps fall out of that alone, verified by reading it against what
-- producer_tags' own recipient SELECT policy (20260815000002) and Part B's storage SELECT policy
-- below actually grant once a producer_tag_sends row exists:
--
--   1. No check that the sender actually OWNS the tag_id being sent. Any authenticated user who
--      has ever legitimately learned a tag_id (e.g. a room member who received a legitimate send)
--      could insert their OWN new producer_tag_sends row naming that same tag_id and an entirely
--      different, unauthorized recipient - re-sharing someone else's private recording to an
--      audience its actual owner never consented to. producer_tags' recipient SELECT policy only
--      checks "does SOME producer_tag_sends row name me as recipient", never who the sender of
--      that row was - so this is a genuine confidentiality gap, not merely theoretical.
--   2. No check that recipient_user_id shares a group with the sender - any authenticated
--      stranger could insert a row naming ANY other user as recipient_user_id, injecting content
--      into a total stranger's inbox with zero prior relationship. Identical shape to
--      friendship_settings' pre-20260815000013 INSERT gap.
--   3. No check that recipient_room_id is a room the sender belongs to - any authenticated
--      stranger could insert a row naming ANY room as recipient_room_id, which becomes visible to
--      every ACTUAL room member via producer_tag_sends' own "room member can read sends" SELECT
--      policy - a stray, unrelated sender's row appearing in a real room's send history despite
--      the sender never having joined it. Identical shape to study_room_participants'
--      pre-20260815000019 join gap.
--
-- Fix: require (a) the sender to own the tag being sent, and (b) EXACTLY one of
-- recipient_user_id/recipient_room_id set (also encoded as a table CHECK constraint just below,
-- belt-and-suspenders against non-RLS-bound writes), gated per-branch:
--   - friend sends: sender and recipient_user_id must share a group (users_share_a_group, the
--     existing two-user helper from 20260815000012 - already reused by study_rooms'/
--     friendship_settings' own floors, not reinvented here).
--   - room sends: sender must be the room's owner OR an existing study_room_participants row for
--     that room (mirrors study_room_participants' own INSERT floor, 20260815000019, exactly -
--     "you can target a room the same way you're allowed to join one").
alter table producer_tag_sends
  add constraint producer_tag_sends_exactly_one_recipient
  check (
    (recipient_user_id is not null and recipient_room_id is null)
    or (recipient_user_id is null and recipient_room_id is not null)
  );

drop policy "senders can create their own sends" on producer_tag_sends;

create policy "senders can create sends for their own tags to an actual friend or a room they belong to"
  on producer_tag_sends
  for insert
  to authenticated
  with check (
    sender_user_id = auth.uid()
    and exists (
      select 1 from producer_tags pt
      where pt.id = producer_tag_sends.tag_id and pt.user_id = auth.uid()
    )
    and (
      (
        recipient_user_id is not null
        and users_share_a_group(sender_user_id, recipient_user_id)
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

-- producer_tag_sends UPDATE/DELETE: still no policy for either verb (unchanged by this
-- migration - 20260815000002 never defined one, and nothing in Tasks 6-13 touched this table).
-- With RLS enabled and no permissive policy for `authenticated`, Postgres denies both outright
-- regardless of the underlying table-level GRANT - confirmed LIVE (not just asserted) in
-- scripts/verify-producer-tags.mjs, per this task's explicit "verify, don't assume" instruction.

-- =============================================================================================
-- Part B: Supabase Storage - first use in this codebase. Bucket creation is a plain row INSERT
-- into storage.buckets (confirmed against current Supabase docs - supabase.com/docs/guides/
-- storage/buckets/creating-buckets - rather than assumed to be a DDL `create` statement), not a
-- new schema object. `public = false` keeps it private: every read/write must pass one of the RLS
-- policies below, exactly like every other table in this codebase - there is no bucket-level
-- "public read" bypass.
insert into storage.buckets (id, name, public)
values ('producer-tags', 'producer-tags', false)
on conflict (id) do nothing;

-- Object path convention: '<tag_id>/clip.webm' - a folder-per-tag layout (not a flat
-- '<tag_id>.webm' filename) specifically so storage.foldername(name) - the documented helper for
-- exactly this pattern (supabase.com/docs/guides/storage/security/access-control) - can extract
-- the owning tag_id as (storage.foldername(name))[1] and join it straight back to producer_tags,
-- the same join producer_tags' own recipient SELECT policy already performs. RLS on
-- storage.objects is enabled by default on every Supabase project (no ALTER TABLE needed here,
-- confirmed against current docs) - by default NO policy exists for it at all, so before these two
-- policies below, every operation on this bucket was already denied outright for every role.
--
-- INSERT: ties the uploaded object to a producer_tags row the caller already owns. Two
-- independent checks, not one: `owner_id = auth.uid()::text` alone would only prove "I'm
-- uploading as myself", saying nothing about WHICH tag_id folder the object lands in - a caller
-- could otherwise upload arbitrary content into a folder for a producer_tags row someone ELSE
-- owns (as long as they don't collide with an existing object - and per producerTagApi.ts's
-- uploadTag(), no producer_tags row is ever inserted by anyone other than its own owner, so this
-- second check is also what makes the folder->row lookup meaningful at all). Requires the
-- producer_tags row to already exist (producerTagApi.ts's uploadTag() inserts that row FIRST,
-- then uploads - see that file's own comment on why this ordering is load-bearing here).
create policy "producer tag owners can upload their own tag audio"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'producer-tags'
    and owner_id = (select auth.uid())::text
    and exists (
      select 1 from producer_tags pt
      where pt.id::text = (storage.foldername(name))[1]
        and pt.user_id = auth.uid()
    )
  );

-- SELECT (download): deliberately re-derives producer_tags' own two 20260815000002 SELECT
-- policies verbatim (owner can read their own; a producer_tag_sends recipient - direct or via
-- room membership - can read a tag sent to them) rather than inventing a looser or
-- differently-scoped check, per this task's explicit "storage access must mirror the relational
-- RLS exactly" instruction. This is the highest-risk surface this task introduces (storage RLS is
-- a wholly separate mechanism from table RLS, per Supabase's own docs - nothing keeps the two in
-- sync automatically), so it is written as a direct copy of the relational check, not a
-- reimplementation that could quietly drift from it over time.
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
              )
          )
        )
    )
  );

-- No UPDATE/DELETE policy for storage.objects - default-deny (no permissive policy for either
-- verb), mirroring producer_tag_sends' own zero-UPDATE/DELETE precedent above. This is also the
-- storage-layer half of Part A.1's fix: without an UPDATE policy, an `upsert: true` re-upload to
-- an existing tag_id's path (which Storage implements as an UPDATE against storage.objects, not a
-- second INSERT) is denied outright - a tag's audio object is exactly as immutable at the storage
-- layer as producer_tags.audio_url/duration_ms now are at the relational layer. producerTagApi.ts
-- uploads with `upsert: false` regardless, so this is defense in depth, not the only thing
-- stopping a legitimate client from doing this.

-- =============================================================================================
-- Part D: Realtime Broadcast authorization - the first use of Supabase Realtime's Broadcast
-- feature anywhere in this codebase (Task 13's subscribeToPresence used Postgres Changes
-- instead, which is authorized entirely differently - via the subscribed TABLE's own RLS SELECT
-- policy, see 20260815000019's header comment). Broadcast has no such automatic table-RLS tie-in;
-- it's gated by RLS policies on the system `realtime.messages` table, scoped per-topic via the
-- realtime.topic() function - confirmed against current docs (supabase.com/docs/guides/realtime/
-- authorization) rather than assumed, per this task's "confirm exact syntax against current docs"
-- instruction. RLS is already enabled by default on realtime.messages (no ALTER TABLE needed -
-- also confirmed against current docs).
--
-- Topic convention: 'study-room-producer-tags:' || room_id - a SIBLING channel to Task 13's
-- existing `study-room-presence-${roomId}` (studyRoomApi.ts), not a reuse of that exact channel:
-- presence's channel is a plain (non-private) Postgres-Changes channel, and mixing that with a
-- private, Broadcast-authorized channel on the same topic is not a combination Supabase's own
-- docs describe or demonstrate - safer to keep them as two independently-authorized channels than
-- risk being the first to rely on undocumented interop between the two mechanisms.
--
-- Both policies mirror producer_tag_sends' own "room member" SELECT clause (20260815000002)
-- exactly - a straight join to study_room_participants on room_id/user_id, no left_at filter
-- (matching that same precedent, and study_rooms'/study_room_participants' own SELECT policies,
-- which likewise never filter on left_at - once you've legitimately joined a room, you keep that
-- room's visibility). Deliberately not scoped any looser (e.g. "any authenticated user") or any
-- tighter (e.g. requiring left_at is null) than what already gates reading the underlying
-- producer_tag_sends row for a room send - storage/broadcast access must mirror the relational
-- RLS, not diverge from it in either direction.
create policy "producer tag room members can receive broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from study_room_participants srp
      where realtime.topic() = 'study-room-producer-tags:' || srp.room_id::text
        and srp.user_id = auth.uid()
    )
  );

create policy "producer tag room members can send broadcasts"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from study_room_participants srp
      where realtime.topic() = 'study-room-producer-tags:' || srp.room_id::text
        and srp.user_id = auth.uid()
    )
  );
