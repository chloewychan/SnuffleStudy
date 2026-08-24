-- v3.3 Task 10: Temp-passcode redesign - approve -> refresh -> unlocked, no code.
--
-- Removes the temp-passcode-specific PBKDF2/salt/lockout machinery entirely. Approval alone is,
-- and always was, the actual security boundary - both approve-temp-passcode and the (now-deleted)
-- redeem-temp-passcode Edge Functions already verified the caller's identity server-side against
-- the row's friend_user_id/requester_user_id; the human-relayed code only ever added friction,
-- never an independent access-control layer. This is NOT a change to
-- src/domain/sites/hardBlockCredential.ts or the permanent hard-block passcode it protects - that
-- credential lives in a completely separate table/store and is untouched by this migration.
--
-- Gap found by checking the CURRENT repo state before writing this (per this task's own
-- instruction to verify the plan's claims, not just apply its literal SQL block verbatim): the
-- plan's given migration is a bare `alter table ... drop column ...`, but
-- 20260815000026_v2_temp_passcode_group_floor.sql's INSERT policy ("users can create their own
-- genuinely-pending temp passcode requests") directly references code_hash/code_salt/
-- failed_attempts/locked_until in its WITH CHECK clause. Postgres tracks that as a real
-- dependency (policies referencing a column register in pg_depend the same way a view or
-- constraint would) - a plain DROP COLUMN against a column a policy's USING/WITH CHECK expression
-- reads fails outright ("cannot drop column ... because other objects depend on it"), it does not
-- silently cascade. So this migration drops + recreates that policy first, with the four
-- approval-implying-column checks removed (they'd reference columns that no longer exist) and
-- every other check (requester_user_id = auth.uid(), status = 'pending', self-assignment guard,
-- shared-group floor) preserved verbatim - only the code-specific predicates are gone, not the
-- security boundary the rest of the policy still enforces.
drop policy "users can create their own genuinely-pending temp passcode requests"
  on temp_passcode_requests;

create policy "users can create their own genuinely-pending temp passcode requests"
  on temp_passcode_requests for insert
  with check (
    requester_user_id = auth.uid()
    -- A request cannot start pre-approved - unchanged intent from 20260815000018/20260815000026,
    -- just with the now-nonexistent code_hash/code_salt/failed_attempts/locked_until checks
    -- dropped (there's nothing left for a genuinely-pending row to carry a stray value in).
    and status = 'pending'
    and expires_at is null
    -- Unchanged from 20260815000018 - a requester cannot name themselves as the approving friend
    -- and self-approve through the legitimate approve-temp-passcode path.
    and requester_user_id <> friend_user_id
    -- Unchanged from 20260815000026 - the assigned friend must actually be someone this requester
    -- shares a group with.
    and users_share_a_group(requester_user_id, friend_user_id)
  );

-- Dropping code_hash/code_salt also drops the column-level GRANT/REVOKE machinery
-- 20260815000016/20260815000017/20260815000018 put in place around those two columns specifically
-- - Postgres removes a column-level grant automatically when the column itself is dropped, so
-- there is nothing further to revoke here. The INSERT policy above no longer references any of
-- the four columns, so this now proceeds without a dependency error.
alter table temp_passcode_requests
  drop column code_hash,
  drop column code_salt,
  drop column failed_attempts,
  drop column locked_until;

-- record_temp_passcode_failed_attempt() only ever existed to atomically increment
-- failed_attempts/locked_until (20260815000017_v2_temp_passcode_lock_down_client_writes.sql) -
-- both columns are gone as of the statement above, so the function is dead code. Explicit
-- (uuid, integer, integer) signature matches that migration's own `create or replace function`
-- declaration exactly.
drop function if exists record_temp_passcode_failed_attempt(uuid, integer, integer);
