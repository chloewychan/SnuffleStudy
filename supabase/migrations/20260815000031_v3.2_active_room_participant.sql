-- v3.2 Task 6: Unify Study Room "active participant" rules.
--
-- Why this task exists (see docs/implementation_plans/V3.2_Implementation_Plan.md, Decision 4):
-- not a live bug. generate-livekit-token/index.ts already filters on `left_at is null` when
-- deciding whether to mint a token, so it doesn't currently disagree with studyRoomApi.ts's own
-- `.is("left_at", null)` filters used for presence/participant listing. The actual risk is that
-- "is this user an active participant in this room" is independently hand-written in both places,
-- with nothing forcing them to agree if either one changes later. This migration centralizes the
-- check into one Postgres function; generate-livekit-token/index.ts now calls it via RPC instead
-- of hand-rolling the query inline.
--
-- Not the same thing as public.is_room_participant(uuid, uuid)
-- (20260815000003_v2_fix_grants_and_rls_recursion.sql), which this migration deliberately leaves
-- untouched: that function answers "has this user ever had a participant row in this room" (no
-- left_at filter at all) and is consumed by study_rooms'/study_room_participants' own RLS
-- policies to gate read/discovery access - a user who has left a room should still be able to see
-- the room existed and who else is/was in it, so that function is correctly permissive of left
-- participants. is_active_room_participant below is narrower on purpose: "is this user a
-- *currently* active participant" (left_at is null), the question the LiveKit token-minting
-- boundary actually needs answered - matching generate-livekit-token/index.ts's existing inline
-- query exactly (room_id = p_room_id, user_id = p_user_id, left_at is null).
--
-- Schema confirmed directly against supabase/migrations/20260815000001_v2_accountability_schema.sql
-- before writing this migration: study_room_participants(room_id uuid not null references
-- study_rooms(id), user_id uuid not null references auth.users(id), joined_at timestamptz not
-- null default now(), left_at timestamptz, primary key (room_id, user_id, joined_at)) - matches
-- this migration's (and the implementation plan's) literal SQL verbatim; no column-name/type
-- adjustment was needed.
--
-- security definer + set search_path = public, matching every other cross-table helper in this
-- schema since 20260815000003 (is_group_member/is_room_participant/is_room_owner) - runs as the
-- owning role, bypassing RLS for the internal read, so it works identically whether called by the
-- service-role adminClient (generate-livekit-token/index.ts's actual caller today) or a future
-- authenticated-role caller.
--
-- Grants intentionally include `authenticated` even though the only caller wired up by this task
-- (generate-livekit-token/index.ts) uses the service-role adminClient, not an authenticated
-- session - matching this schema's existing convention of granting EXECUTE to both roles on every
-- helper function of this shape (is_group_member/is_room_participant/is_room_owner all do the
-- same), and leaving the door open for studyRoomApi.ts to call this same function via RPC later.
-- That follow-up is explicitly out of scope for this task (see V3.2_Implementation_Plan.md's
-- Task 6 "Deliverables" and the plan's "Explicitly out of scope" section) -
-- studyRoomApi.ts's own `.is("left_at", null)` filters are left untouched here on purpose, since
-- they run through RLS as the authenticated user (not the service-role client this Edge Function
-- uses) and a client-side listing query being wrong only affects what a legitimate participant
-- sees in their own UI, not who can obtain a valid video token.
create or replace function public.is_active_room_participant(
  p_room_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from study_room_participants
    where room_id = p_room_id
      and user_id = p_user_id
      and left_at is null
  );
$$;

revoke all on function public.is_active_room_participant(uuid, uuid) from public;
grant execute on function public.is_active_room_participant(uuid, uuid) to authenticated, service_role;
