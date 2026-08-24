-- v3.3 Task 6: Archive study rooms (soft delete).
--
-- A room's owner needs a way to remove it from the joinable list without a hard DELETE -
-- producer_tag_sends.recipient_room_id references study_rooms(id) (supabase/migrations/
-- 20260815000001_v2_accountability_schema.sql), and this schema has no ON DELETE CASCADE
-- anywhere (confirmed by grepping every `references`/`on delete` across supabase/migrations/*.sql
-- - same finding 20260815000032_v3.2_account_deletion.sql's own header documents), so a real
-- DELETE on study_rooms would either hit an FK violation from any historical Producer Tag send
-- into that room, or - if that were worked around - silently erase real Producer Tag history that
-- has nothing to do with the room being archived. archived_at is a plain nullable timestamp: null
-- means active/joinable (the default, unchanged behavior for every existing row), non-null means
-- the owner archived it.
--
-- Verified against the current repo before writing this: study_rooms (20260815000001) has no
-- UPDATE policy at all today - the table's only policies are "owner can create study rooms"
-- (INSERT) and "owner group-mates and participants can read study rooms" (SELECT, widened by
-- 20260815000019). Adding an UPDATE policy here is a genuinely new capability, not a
-- widening/narrowing of an existing one.
alter table study_rooms add column archived_at timestamptz;

-- Owner-only, matching this table's existing INSERT policy's identical "owner_user_id = auth.uid()"
-- shape - no group-mate/participant carve-out the way the SELECT policy has, since archiving is an
-- owner-only action, not a shared-visibility one. `with check` re-asserts the same predicate on
-- the row's post-update state so an owner can't use this policy to reassign owner_user_id to
-- someone else in the same statement that archives it.
create policy "owner can archive their own room"
  on study_rooms for update
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());
