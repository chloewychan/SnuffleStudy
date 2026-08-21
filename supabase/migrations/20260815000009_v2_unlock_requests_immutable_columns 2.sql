-- v2 Task 8 fix round 1: pin hostname/session_id/requester_user_id immutable across UPDATE.
--
-- Gap this closes: 20260815000008's UPDATE policy is the first place a non-requester
-- (any pending-group-member) gains genuine UPDATE access to an unlock_requests row before it's
-- resolved. Its `with check (resolved_by = auth.uid() and status in ('approved', 'denied'))`
-- constrains only those two columns - it says nothing about hostname/session_id/
-- requester_user_id, so nothing in RLS stops a resolving group member from also rewriting any of
-- those three in the same UPDATE. Not reachable through this app's own UI/client code today
-- (unlockRequestApi.ts's resolveRequest() only ever sends status/resolved_at/resolved_by) - but a
-- hand-crafted request bypassing that module could submit
-- `{status: 'approved', resolved_by: <self>, hostname: 'attacker-chosen.com'}` and it would pass
-- RLS as-is. Since alarmHandlers.ts's applyApprovedUnlockRequest trusts whatever `hostname` comes
-- back on the resolved row and merges it straight into the requester's session's allowedSites,
-- this would let a rogue/compromised group member silently whitelist an arbitrary hostname in the
-- requester's session rather than the one actually requested - a real, newly-reachable
-- defense-in-depth gap, not merely theoretical.
--
-- Why a trigger instead of a wider WITH CHECK: plain `with check` can only inspect the proposed
-- NEW row in isolation - it has no way to diff NEW against OLD, so it cannot express "these
-- columns must not change" (as opposed to "these columns must hold some particular value"). A
-- `before update` trigger is the standard Postgres pattern for column-immutability under RLS: it
-- runs with access to both OLD and NEW and can raise an exception to abort the statement entirely
-- if an immutable column differs, independent of whichever RLS policy authorized the UPDATE
-- attempt in the first place. This applies to every UPDATE on the table regardless of who's
-- performing it (including the requester's own unconditional update path from 20260815000008),
-- which is correct - hostname/session_id/requester_user_id should never change on any unlock
-- request, resolved by the requester or by a friend.

create or replace function unlock_requests_prevent_immutable_column_changes()
returns trigger
language plpgsql
as $$
begin
  if new.hostname <> old.hostname
    or new.session_id <> old.session_id
    or new.requester_user_id <> old.requester_user_id
  then
    raise exception 'hostname, session_id, and requester_user_id cannot be changed on an unlock request';
  end if;
  return new;
end;
$$;

create trigger unlock_requests_immutable_columns
  before update on unlock_requests
  for each row
  execute function unlock_requests_prevent_immutable_column_changes();
