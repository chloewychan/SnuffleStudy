-- v2 Task 6 follow-up: fixes a real bug found by actually running scripts/verify-friend-sync.mjs
-- against the live project (same discovery method as 20260815000003/20260815000005 - the
-- original policy was verified only by inspecting schema/policy listings, never by exercising it
-- as two distinct authenticated non-superuser roles, which is what surfaced this).
--
-- Bug: cross-table RLS recursion, same failure family as 20260815000003's group_memberships
-- self-join bug, but across two different tables instead of one. session_status_events'
-- "group members can read visible friend session events" policy (migration 2) subqueries
-- friendship_settings directly:
--
--   exists (
--     select 1 from friendship_settings fs
--     where fs.user_id = session_status_events.user_id   -- the event owner, e.g. A
--       and fs.friend_user_id = auth.uid()                -- the viewer, e.g. B
--       and fs.send_live_nudges = true
--   )
--
-- That subquery runs under the *viewer's* (B's) role, so it is itself subject to
-- friendship_settings' own RLS policy ("users manage only their own settings rows": using/with
-- check user_id = auth.uid()). The row this subquery needs to find has user_id = A (the friend
-- who granted visibility), not user_id = B - and friendship_settings' policy explicitly denies B
-- from reading any row where B is friend_user_id (that's A's control over the relationship, per
-- that policy's own comment: "a user can never read or modify the friendship_settings row where
-- they are the friend_user_id"). So the EXISTS above evaluates false for every B, unconditionally
-- - not because visibility wasn't granted, but because the *check for whether it was granted* is
-- itself blocked by the row it's trying to read. Confirmed live: A enabling send_live_nudges
-- toward B, then B polling session_status_events, returned zero rows even though the policy's
-- intent (and the group-membership half of the same EXISTS clause) was satisfied.
--
-- Fix: identical technique to 20260815000003/20260815000005 - a SECURITY DEFINER helper function
-- that runs with its owner's privileges (postgres, who owns friendship_settings and was never
-- subjected to FORCE ROW LEVEL SECURITY on it), so the visibility check can read the *other*
-- person's settings row without needing friendship_settings' own RLS to permit it for the
-- current role. This does not weaken friendship_settings' own direct-access guarantee (its table
-- policy is untouched - B still cannot SELECT/UPDATE that row directly via `.from(
-- "friendship_settings")`), it only lets this one narrow, hardcoded boolean check run instead.
--
-- The group_memberships half of the original EXISTS clause is left as a raw self-join, not
-- switched to the is_group_member() helper from 20260815000003 - confirmed live (via the same
-- verification script) that this half already works correctly as written: unlike
-- friendship_settings' policy (which denies the viewer for exactly the row needed), the current
-- group_memberships policy (routed through is_group_member() since 20260815000003) grants a
-- member visibility into *every* membership row of any group they belong to, not just their own
-- row - so both A's and B's rows in a shared group are already visible to B under that policy,
-- with no recursion or cross-role denial to fix.

create or replace function public.friend_has_granted_live_visibility(
  p_owner_user_id uuid,
  p_viewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from friendship_settings
    where user_id = p_owner_user_id
      and friend_user_id = p_viewer_user_id
      and send_live_nudges = true
  );
$$;

revoke all on function public.friend_has_granted_live_visibility(uuid, uuid) from public;
grant execute on function public.friend_has_granted_live_visibility(uuid, uuid)
  to authenticated, service_role;

drop policy "group members can read visible friend session events" on session_status_events;
create policy "group members can read visible friend session events"
  on session_status_events for select
  using (
    exists (
      select 1 from group_memberships gm_self
      join group_memberships gm_owner on gm_owner.group_id = gm_self.group_id
      where gm_self.user_id = auth.uid()
        and gm_owner.user_id = session_status_events.user_id
    )
    and friend_has_granted_live_visibility(session_status_events.user_id, auth.uid())
  );
