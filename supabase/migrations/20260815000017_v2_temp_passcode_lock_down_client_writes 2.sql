-- v2 Task 12, fix round 1 (Critical finding from code review).
--
-- The original migration (20260815000016_v2_temp_passcode_hard_mode.sql) narrowed SELECT on
-- temp_passcode_requests (revoking code_hash/code_salt) but never touched UPDATE. Combined with
-- the pre-existing, unrestricted table-level grant (`grant select, insert, update, delete on
-- temp_passcode_requests to authenticated, service_role` - 20260815000003) and Task 5's original
-- RLS policy ("requester or assigned friend can update temp passcode requests" - USING/WITH CHECK
-- both just `requester_user_id = auth.uid() or friend_user_id = auth.uid()`, with NO column-level
-- restriction on what can be changed), any authenticated requester could directly:
--
--   supabase.from("temp_passcode_requests").update({
--     status: "approved",
--     code_hash: <hash of a self-chosen code, computed with the same public PBKDF2 algorithm
--                 that already ships in the extension bundle - src/domain/sites/
--                 hardBlockCredential.ts>,
--     code_salt: <a self-chosen salt>,
--     expires_at: <any future timestamp>,
--     failed_attempts: 0,
--     locked_until: null,
--   }).eq("id", theirOwnPendingRequestId)
--
-- This passes RLS (requester_user_id = auth.uid() is satisfied trivially) and the unrestricted
-- grant, then redeem-temp-passcode happily verifies the self-chosen code against the self-chosen
-- hash - no friend involvement at all, and an arbitrarily long unlock window, not time-boxed. This
-- fully defeated the feature's entire trust model ("a designated friend must approve") and was
-- strictly worse than v1's HardBlockCredential, which at minimum requires local browser-profile
-- access - this required nothing but a normal authenticated API call.
--
-- Fix: revoke UPDATE from `authenticated` entirely - not narrowed by column, REMOVED. Every
-- legitimate client-driven state change now goes through either an Edge Function running as
-- service_role (approve-temp-passcode, redeem-temp-passcode - both unaffected, service_role's own
-- grant is untouched) or the new deny_temp_passcode_request() RPC below, which permits ONLY a
-- pending -> denied transition, only by the row's own friend_user_id, touching only
-- status/resolved_at. No client-reachable path can ever again set status to 'approved', or touch
-- code_hash/code_salt/expires_at/failed_attempts/locked_until.
revoke update on temp_passcode_requests from authenticated;

-- tempPasscodeApi.ts's denyRequest() calls this instead of a direct table UPDATE now. Mirrors the
-- SECURITY DEFINER helper-function pattern used throughout this schema (is_group_member,
-- can_send_nudge, etc. - 20260815000003/20260815000005/20260815000007) - runs with the function
-- owner's privileges (bypassing the just-revoked client UPDATE grant), but re-derives and enforces
-- its own authorization (friend_user_id = auth.uid()) and state-machine guard (status = 'pending')
-- internally, exactly the way approve-temp-passcode/redeem-temp-passcode already do server-side.
-- `if not found then raise exception` converts "zero rows matched" (wrong id, not the assigned
-- friend, or already resolved) into a real Postgres error the caller can see, rather than a
-- silent no-op - same "first responder wins"-safety rationale unlock_requests' resolveRequest()
-- already relies on (chaining `.select().single()` there; here, the exception serves the
-- identical purpose from inside the function itself).
create or replace function public.deny_temp_passcode_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update temp_passcode_requests
  set status = 'denied',
      resolved_at = now()
  where id = p_request_id
    and friend_user_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Could not deny this request - it may already have been resolved, or you are not the assigned friend.';
  end if;
end;
$$;

revoke all on function public.deny_temp_passcode_request(uuid) from public;
grant execute on function public.deny_temp_passcode_request(uuid) to authenticated, service_role;

-- v2 Task 12, fix round 1 (Important finding from code review).
--
-- redeem-temp-passcode's failure branch previously read failed_attempts, computed +1 in
-- application code, then issued a separate UPDATE - two round trips, not one transaction. Two
-- concurrent wrong-guess requests could both read the same stale count and each independently
-- write "stale + 1", so N concurrent guesses could advance the counter by less than N, letting an
-- attacker firing guesses in parallel get meaningfully more than MAX_ATTEMPTS_BEFORE_LOCKOUT (3)
-- real attempts before the lockout actually engages. v1's single-threaded, client-local
-- verifyPasscode never had this exposure (there's only ever one caller, on one device).
--
-- Fix: a single atomic UPDATE ... SET failed_attempts = failed_attempts + 1 ... RETURNING,
-- executed as one PL/pgSQL-free SQL-language function. Postgres's own row-level locking during
-- UPDATE serializes concurrent writers to the same row - the second of two concurrent callers
-- necessarily blocks until the first's UPDATE commits, then reads the FIRST caller's
-- already-incremented value as ITS OWN base for +1, not a stale value read separately by both.
-- No advisory lock or explicit transaction needed (contrast
-- check_and_record_coaching_message_request's pg_advisory_xact_lock, 20260815000015 - that
-- function's race was between a SELECT count(...) and a separate INSERT, which really did need an
-- explicit lock; this one is a single UPDATE referencing the row's own current value, which
-- Postgres already serializes for free).
--
-- service_role-only grant (mirrors compute_daily_digests()'s identical service_role-only pattern,
-- 20260815000010) - this is an internal bookkeeping primitive for redeem-temp-passcode's own use,
-- not a general-purpose client-callable RPC: it performs no status/expiry/already-locked checks of
-- its own (those remain redeem-temp-passcode's job, evaluated before this is ever called) and a
-- client has no legitimate reason to call it directly. The `and status = 'approved'` guard below
-- is defense-in-depth, not the primary security boundary - it just avoids incrementing a
-- not-actually-approved row's counter as a no-op-safe default.
create or replace function public.record_temp_passcode_failed_attempt(
  p_request_id uuid,
  p_max_attempts integer,
  p_lockout_seconds integer
)
returns table (failed_attempts integer, locked_until timestamptz)
language sql
security definer
set search_path = public
as $$
  update temp_passcode_requests
  set failed_attempts = temp_passcode_requests.failed_attempts + 1,
      locked_until = case
        when temp_passcode_requests.failed_attempts + 1 >= p_max_attempts
          then now() + make_interval(secs => p_lockout_seconds)
        else temp_passcode_requests.locked_until
      end
  where id = p_request_id
    and status = 'approved'
  returning temp_passcode_requests.failed_attempts, temp_passcode_requests.locked_until;
$$;

revoke all on function public.record_temp_passcode_failed_attempt(uuid, integer, integer) from public;
grant execute on function public.record_temp_passcode_failed_attempt(uuid, integer, integer) to service_role;
