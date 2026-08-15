-- v2 Task 8: Unlock requests - resolves the chicken-and-egg visibility gap the plan's own
-- migration 20260815000002 comment explicitly flagged and deferred to this task.
--
-- Recap of the gap: unlock_requests' original SELECT/UPDATE policies only allowed
-- `requester_user_id = auth.uid() OR resolved_by = auth.uid()`. resolved_by is null until
-- someone resolves the request, so under that literal policy no friend could ever be the FIRST
-- to discover or resolve a pending request - they're not the requester, and `resolved_by =
-- auth.uid()` can never match a null column. Task 5's own definition of done only required a
-- negative test against an ALREADY-RESOLVED request belonging to someone else (which the
-- original policy correctly denies, and continues to correctly deny below) - group-wide pending
-- visibility, so a friend can actually see and act on a brand-new request, is this task's job.
--
-- Fix model: unlock_requests has no "assigned friend" column (unlike temp_passcode_requests,
-- which has friend_user_id for exactly that different one-designated-friend model) - the task
-- brief describes this feature as "notify the group", so visibility is widened to ANY member of
-- a group shared with the requester, but ONLY while the request is still `status = 'pending'`.
-- Once resolved, visibility collapses back down to just the requester and whoever resolved it -
-- preserving Task 5's original "not the whole group" guarantee for resolved requests, which
-- scripts/verify-rls.mjs already exercises and must keep passing unchanged.
--
-- Group-membership check: modeled directly on session_status_events' existing "group members can
-- read visible friend session events" policy (20260815000002/20260815000006) - a plain double
-- self-join on group_memberships, evaluated directly in the policy body rather than through a
-- SECURITY DEFINER helper function. This is deliberately NOT the is_group_member() helper
-- pattern from 20260815000003/20260815000005 (which takes a single (group_id, user_id) pair and
-- doesn't fit a "do these two users share ANY group" check), and deliberately does NOT touch
-- friendship_settings at all - the brief has no per-friendship visibility gate on unlock
-- requests, just "notify the group", so there's no cross-table recursion risk to guard against
-- here the way 20260815000006 had to for session_status_events' friendship_settings subquery.
-- The direct group_memberships self-join is already proven live (via scripts/verify-friend-sync.mjs)
-- to work without the recursion 20260815000003/20260815000006 each had to fix in a follow-up
-- migration for other tables, so it's used as-is here from the start.
--
-- UPDATE policy / "first responder wins" race safety: USING allows a group member to attempt the
-- update only `while status = 'pending'`; WITH CHECK requires the resulting row to have
-- `resolved_by = auth.uid() AND status IN ('approved', 'denied')`. Once one friend's UPDATE
-- flips status away from 'pending', a concurrent/later UPDATE from a second friend targeting the
-- same row no longer matches USING's `status = 'pending'` condition (Postgres re-evaluates USING
-- against the row as it exists at the time of that second statement) and is silently excluded
-- from the update (zero rows affected, not a permission error) - the same race-safety shape as
-- invite_codes' "unused unexpired codes can be redeemed once" policy (20260815000002). The
-- requester's own `requester_user_id = auth.uid()` clause is kept in USING unconditionally (not
-- gated on status = 'pending') so a requester can also resolve/cancel their own request at any
-- time (e.g. setting status = 'denied' on their own row to withdraw it) - not required by the
-- brief, but cheap to support and consistent with the original migration 20260815000002 policy's
-- behavior, which scripts/verify-rls.mjs's existing "A resolves their own request" check already
-- relies on.

drop policy "requester or resolver can read unlock requests" on unlock_requests;
create policy "requester resolver or pending-group-member can read unlock requests"
  on unlock_requests for select
  using (
    requester_user_id = auth.uid()
    or resolved_by = auth.uid()
    or (
      status = 'pending'
      and exists (
        select 1 from group_memberships gm_self
        join group_memberships gm_requester on gm_requester.group_id = gm_self.group_id
        where gm_self.user_id = auth.uid()
          and gm_requester.user_id = unlock_requests.requester_user_id
      )
    )
  );

drop policy "requester or resolver can update unlock requests" on unlock_requests;
create policy "requester or pending-group-member can resolve unlock requests"
  on unlock_requests for update
  using (
    requester_user_id = auth.uid()
    or (
      status = 'pending'
      and exists (
        select 1 from group_memberships gm_self
        join group_memberships gm_requester on gm_requester.group_id = gm_self.group_id
        where gm_self.user_id = auth.uid()
          and gm_requester.user_id = unlock_requests.requester_user_id
      )
    )
  )
  with check (
    resolved_by = auth.uid()
    and status in ('approved', 'denied')
  );
