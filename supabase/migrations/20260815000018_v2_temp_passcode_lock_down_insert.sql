-- v2 Task 12, fix round 2 (Critical finding from re-review - same vulnerability class as fix
-- round 1, a different route to the identical impact).
--
-- Fix round 1 (20260815000017) closed the UPDATE path: any authenticated requester could
-- previously UPDATE their own pending row's status/code_hash/code_salt/expires_at directly,
-- self-approving with a code they chose themselves. That migration's own comment claimed "No
-- client-reachable path can ever again set status to 'approved'" - true only for UPDATE. The
-- IDENTICAL impact was still reachable via INSERT: the Task 5 INSERT policy
-- (20260815000002_v2_rls_policies.sql) only ever validated `requester_user_id = auth.uid()` - it
-- placed zero constraint on status/code_hash/code_salt/expires_at/failed_attempts/locked_until.
-- Combined with the unrestricted INSERT grant to `authenticated` (20260815000003, untouched by
-- fix round 1's UPDATE-only revoke) and this table's CHECK constraint permitting
-- status = 'approved' from row creation (20260815000001) plus code_hash/expires_at being merely
-- nullable rather than constrained-to-null-at-insert (20260815000016), an attacker could INSERT a
-- pre-'approved' row with a self-chosen code_hash/code_salt in one call:
--
--   supabase.from("temp_passcode_requests").insert({
--     session_id: "x", hostname: "target.com",
--     requester_user_id: selfId, friend_user_id: anyValidUid,
--     status: "approved",
--     code_hash: attackerComputeHash("999999", salt), code_salt: salt,
--     expires_at: futureIso, delivered_via: "email",
--     failed_attempts: 0, locked_until: null,
--   })
--
-- then immediately redeem with their own chosen code - no friend involvement at all, an
-- arbitrarily long unlock window. Identical impact to fix round 1's UPDATE exploit, just via the
-- other DML verb.
--
-- Fix: tighten the INSERT policy's WITH CHECK at the exact same layer the UPDATE fix used (RLS),
-- rather than a schema/trigger change - a genuinely pending request, by construction, cannot carry
-- an approval-implying value in any of these columns yet; only approve-temp-passcode (running as
-- service_role, which bypasses RLS entirely) should ever be able to set them. The legitimate
-- client insert path (tempPasscodeApi.ts's createRequest) already only ever sets session_id/
-- hostname/requester_user_id/friend_user_id/status:'pending'/delivered_via and leaves every other
-- column to its schema default (code_hash/code_salt/expires_at/locked_until all default to NULL,
-- failed_attempts defaults to 0) - so this tightening requires NO client-code change, only rows
-- that were never legitimate to begin with are newly rejected.
drop policy "users can create their own temp passcode requests" on temp_passcode_requests;

create policy "users can create their own genuinely-pending temp passcode requests"
  on temp_passcode_requests for insert
  with check (
    requester_user_id = auth.uid()
    -- The core fix round 2 finding: a request cannot start pre-approved, or carrying any value
    -- only approve-temp-passcode should ever set.
    and status = 'pending'
    and code_hash is null
    and code_salt is null
    and failed_attempts = 0
    and locked_until is null
    and expires_at is null
    -- Additional finding from the same audit pass, not explicitly reported but directly adjacent:
    -- requester_user_id <> friend_user_id was never enforced anywhere. Without it, a requester
    -- could name THEMSELVES as the assigned friend, then call the legitimate
    -- approve-temp-passcode Edge Function as themselves - its own authorization check
    -- (friend_user_id = caller) is trivially satisfied when the two ids are equal - and self-issue
    -- a real, correctly-hashed code with zero second-party involvement. No forged hash needed;
    -- the entire "a friend must approve" trust model bypassed through the LEGITIMATE approval path
    -- instead of around it. LockedPage.tsx's friend-picker UI already excludes the current user
    -- from its list, but that's a client-side convenience only, not a security boundary - this is
    -- the actual server-side one.
    and requester_user_id <> friend_user_id
  );
