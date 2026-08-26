-- v3.4 Task 3 fix: a friend resolving a group-wide (friend_user_id IS NULL, "any friend,
-- first-responder-wins") friend_requests row could not actually resolve it at all - the very
-- feature the DoD explicitly requires be exercised live, not just inspected. Found by
-- scripts/verify-friend-requests.mjs's own Case 1 ("D, A's friend but not specifically assigned,
-- CAN resolve" A's group-wide site_unlock request) - that check FAILED against the live DB with
-- "new row violates row-level security policy for table \"friend_requests\"" even though the
-- WITH CHECK clause (20260815000041) plainly permits it (status='approved' and resolved_by=D and
-- kind<>'site_temp_pass' - all true). Root-caused via a from-scratch minimal reproduction
-- (documented in this task's report) against a throwaway scratch table with the identical
-- USING/WITH CHECK shape: **PostgreSQL's row-security enforcement for UPDATE also re-checks the
-- UPDATE policy's own USING clause against the RESULTING (new) row, in addition to WITH CHECK -
-- confirmed even with an unconditional `with check (true)`, which still failed the same way.**
-- WITH CHECK can only ever NARROW what USING already permits, never widen it. This is genuine,
-- reproducible Postgres behavior on this project, not a client-library or script artifact (the
-- raw `pg` connection reproduces it identically to the real supabase-js/PostgREST call).
--
-- Concretely: 20260815000041's USING clause has three branches - requester, assigned friend, or
-- (friend_user_id is null AND status='pending' AND are_friends(...)). A friend resolving via the
-- THIRD branch necessarily changes status away from 'pending', so on the new row that branch goes
-- false - and since they're neither the requester nor the assigned friend (there IS no assigned
-- friend on a null-friend_user_id row), NO branch holds on the new row, so Postgres rejects the
-- UPDATE outright regardless of what WITH CHECK says. A requester self-resolving (branch 1) or an
-- assigned friend resolving their own assignment (branch 2) both stay true on the new row
-- regardless of status, which is exactly why those two paths (Decision 4's positive case, and
-- site_temp_pass's assigned-friend path) already worked and only this one didn't.
--
-- This is a genuine pre-existing-precedent gap, not a new idea introduced by this fix: the OLD
-- unlock_requests table's SELECT policy (20260815000008_v2_unlock_request_group_visibility.sql)
-- already had a `resolved_by = auth.uid()` branch for exactly this "so a resolver keeps their own
-- access after resolving" reason ("Once resolved, visibility collapses back down to just the
-- requester and whoever resolved it" - that migration's own comment) - 20260815000041's
-- consolidated policy set dropped that branch when merging three tables' policies into one
-- (verified directly: neither the plan's own SQL nor the shipped migration includes it - this
-- isn't a deviation introduced by implementation, it's a spec-level gap that only a live,
-- actually-exercised third-party-resolver test could catch, exactly as the DoD anticipated by
-- requiring this be exercised live rather than only inspected).
--
-- Fix: add `resolved_by = auth.uid()` as an additional OR-branch to BOTH the SELECT and UPDATE
-- policies' USING clauses (kept identical to each other, same as before this fix). For UPDATE,
-- this is what makes the post-resolve new row remain visible to the resolver (fixing the outright
-- rejection). For SELECT, this restores the same "the resolver keeps their own read access
-- afterward" guarantee unlock_requests' SELECT policy already had - without it, a friend who
-- resolves a group-wide request would immediately lose the ability to see the row they just
-- resolved (no longer the requester, friend_user_id still null, status no longer 'pending').
-- WITH CHECK on the UPDATE policy is unchanged - Decision 3's site_temp_pass exclusion and
-- Decision 4's preserved self-resolve quirk are untouched by this fix.
--
-- Verified via scripts/verify-friend-requests.mjs after applying this migration: Case 1's "D CAN
-- resolve" now passes, and the full 33-check suite passes with zero failures.

-- Policy names kept under Postgres's 63-byte identifier limit (unlike the two names this
-- replaces, which were already silently truncated by Postgres at creation time in
-- 20260815000041 - confirmed directly via pg_policies before picking these).
drop policy "requester assigned friend or pending-friend can read friend requests" on friend_requests;
create policy "requester assigned or resolving friend can read requests"
  on friend_requests for select
  using (
    requester_user_id = auth.uid()
    or friend_user_id = auth.uid()
    or resolved_by = auth.uid()
    or (
      friend_user_id is null
      and status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  );

drop policy "requester assigned friend or pending-friend can resolve friend requests" on friend_requests;
create policy "requester assigned or resolving friend can resolve requests"
  on friend_requests for update
  using (
    requester_user_id = auth.uid()
    or friend_user_id = auth.uid()
    or resolved_by = auth.uid()
    or (
      friend_user_id is null
      and status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  )
  with check (
    resolved_by = auth.uid()
    and (
      status = 'denied'
      or (status = 'approved' and kind <> 'site_temp_pass')
    )
  );
