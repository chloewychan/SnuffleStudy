-- v2 Task 5 fix round 1: closes a real privilege-escalation path found in code review.
--
-- group_memberships' original INSERT policy ("users can insert their own membership row",
-- migration 2) only checked `user_id = auth.uid()` - it never verified the inserting user had
-- actually redeemed a valid invite code for that group. Any authenticated user who learns a
-- group_id (trivial: invite_codes is broadly readable to any authenticated user per the plan's
-- own spec - every currently-valid code's group_id is visible via an unfiltered `select()`)
-- could insert themselves into group_memberships directly via the REST API, bypassing
-- friendGroupApi.ts's joinGroup() control flow entirely. Since group membership gates
-- session_status_events visibility ("group members can read visible friend session events",
-- migration 2), an uninvited stranger could read other users' session activity.
--
-- Fix: require either (a) a matching invite_codes row already redeemed by this user for this
-- group, or (b) this user owns the group (friendGroupApi.ts's createGroup() inserts the owner's
-- own membership row with no invite code to redeem - see its comment for why that insert can't
-- be replaced by relying on an invite code). Both checks go through SECURITY DEFINER helper
-- functions, consistent with 20260815000003's is_group_member/is_room_participant/is_room_owner
-- pattern, so this policy doesn't introduce a fresh RLS recursion risk by directly subquerying
-- friend_groups/invite_codes (each of which has its own policies) from within another table's
-- policy.
--
-- friendGroupApi.ts's joinGroup() is updated in the same change to redeem the code (UPDATE
-- invite_codes SET used_by) *before* inserting the group_memberships row, since this check has
-- nothing to find otherwise - membership-insert-before-redemption was the previous (buggy)
-- order.

create or replace function public.is_group_owner(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from friend_groups
    where id = p_group_id and owner_user_id = p_user_id
  );
$$;

revoke all on function public.is_group_owner(uuid, uuid) from public;
grant execute on function public.is_group_owner(uuid, uuid) to authenticated, service_role;

create or replace function public.has_redeemed_invite_code(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from invite_codes
    where group_id = p_group_id and used_by = p_user_id
  );
$$;

revoke all on function public.has_redeemed_invite_code(uuid, uuid) from public;
grant execute on function public.has_redeemed_invite_code(uuid, uuid) to authenticated, service_role;

drop policy "users can insert their own membership row" on group_memberships;
create policy "users can insert their own membership row via a redeemed invite or as owner"
  on group_memberships for insert
  with check (
    user_id = auth.uid()
    and (
      is_group_owner(group_memberships.group_id, auth.uid())
      or has_redeemed_invite_code(group_memberships.group_id, auth.uid())
    )
  );
