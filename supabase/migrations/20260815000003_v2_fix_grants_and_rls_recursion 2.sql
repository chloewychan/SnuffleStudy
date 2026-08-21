-- v2 Task 5 follow-up: fixes two real bugs found by actually running scripts/verify-rls.mjs
-- against the live project (the original two migrations were verified by inspecting schema/
-- policy listings - supabase/verify-schema.mjs - never by exercising them as an authenticated
-- non-superuser role, which is what surfaced these).
--
-- Bug 1 - missing table-level GRANTs. `alter table ... enable row level security` (previous
-- migration) does not itself grant "authenticated"/"service_role" the underlying SQL-level
-- SELECT/INSERT/UPDATE/DELETE privilege - Postgres checks GRANTs before it ever considers RLS
-- policies. Every one of Task 5's tables came out of the first migration with only this
-- project's default REFERENCES/TRIGGER/TRUNCATE grants (confirmed via
-- information_schema.role_table_grants), so every authenticated request against them failed
-- outright with "permission denied for table X", never reaching a policy at all.
--
-- Bug 2 - infinite RLS recursion. Two policies subquery their own table from within their own
-- USING clause: group_memberships' "members can read memberships of their own groups", and
-- study_room_participants' "participants and owner can read room participant rows". Evaluating
-- either policy requires re-evaluating the same policy, which Postgres detects and rejects
-- ("infinite recursion detected in policy for relation ..."). study_rooms and
-- study_room_participants additionally form a mutual A-queries-B / B-queries-A cycle (each
-- table's policy subqueries the other), which is the same failure mode across two tables
-- instead of one.
--
-- Both recursion cases are fixed the standard way for this pattern: a SECURITY DEFINER helper
-- function. Such a function runs with its owner's privileges (here, `postgres`, which owns
-- every Task 5 table and was never subjected to FORCE ROW LEVEL SECURITY on them) - that
-- bypasses RLS for the read the function does internally, so a policy can reuse the same
-- membership check without re-triggering itself or the table it's checking.

grant select, insert, update, delete on
  friend_groups,
  group_memberships,
  invite_codes,
  friendship_settings,
  session_status_events,
  unlock_requests,
  temp_passcode_requests,
  study_rooms,
  study_room_participants,
  producer_tags,
  producer_tag_sends
to authenticated, service_role;

create or replace function public.is_group_member(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from group_memberships
    where group_id = p_group_id and user_id = p_user_id
  );
$$;

revoke all on function public.is_group_member(uuid, uuid) from public;
grant execute on function public.is_group_member(uuid, uuid) to authenticated, service_role;

create or replace function public.is_room_participant(p_room_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from study_room_participants
    where room_id = p_room_id and user_id = p_user_id
  );
$$;

revoke all on function public.is_room_participant(uuid, uuid) from public;
grant execute on function public.is_room_participant(uuid, uuid) to authenticated, service_role;

create or replace function public.is_room_owner(p_room_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from study_rooms
    where id = p_room_id and owner_user_id = p_user_id
  );
$$;

revoke all on function public.is_room_owner(uuid, uuid) from public;
grant execute on function public.is_room_owner(uuid, uuid) to authenticated, service_role;

-- group_memberships: same guarantee as before ("a member of this row's group can read it"),
-- routed through the helper function instead of a raw self-subquery.
drop policy "members can read memberships of their own groups" on group_memberships;
create policy "members can read memberships of their own groups"
  on group_memberships for select
  using (is_group_member(group_memberships.group_id, auth.uid()));

-- study_rooms: rewritten to call the helper too - the mutual cycle with study_room_participants
-- only breaks if *both* sides stop directly subquerying each other's RLS-protected table.
drop policy "owner and participants can read study rooms" on study_rooms;
create policy "owner and participants can read study rooms"
  on study_rooms for select
  using (
    owner_user_id = auth.uid()
    or is_room_participant(study_rooms.id, auth.uid())
  );

-- study_room_participants: same guarantee as before, both the self-subquery and the
-- study_rooms subquery (the other half of the cycle) go through the helper functions.
drop policy "participants and owner can read room participant rows" on study_room_participants;
create policy "participants and owner can read room participant rows"
  on study_room_participants for select
  using (
    is_room_participant(study_room_participants.room_id, auth.uid())
    or is_room_owner(study_room_participants.room_id, auth.uid())
  );
