-- v2 Task 11 fix round 1: atomic check-and-record for the coaching-message rate limiter.
--
-- Prior to this migration, generate-coaching-message/index.ts performed the rate-limit check as
-- TWO separate round trips: a SELECT count(...) against coaching_message_requests, then (if
-- admitted) a separate INSERT. This had two problems, both closed here:
--
-- 1. Latency (the concrete motivation for this migration, discovered during fix round 1's
--    latency investigation): each round trip is a full network hop from the Edge Function to
--    Postgres. Collapsing check+insert into one PL/pgSQL function called via a single RPC removes
--    one of those hops - a real, measured latency win against coachingApi.ts's 800ms client-side
--    race timeout (see task-11-report.md's "Fix round 1" section for before/after numbers).
-- 2. Atomicity (the "Minor" finding from the same review round): the old two-step check-then-
--    insert had a race window - two concurrent requests from the same user could both read a
--    count below the limit before either had inserted its own row, both getting admitted even at
--    the ceiling. `pg_advisory_xact_lock(hashtext(...))`, scoped to the calling user's id and held
--    for the duration of the function's implicit transaction, serializes concurrent calls for the
--    SAME user (different users never contend with each other, since they hash to different lock
--    keys) - the second concurrent call for the same user blocks until the first's transaction
--    commits, then sees the first's already-inserted row when it re-checks the count.
--
-- SECURITY DEFINER (matching every other cross-table helper in this schema since 20260815000003)
-- so it can read/write coaching_message_requests despite that table's own RLS having no policies
-- at all (20260815000014) - the function runs as its owning role, never subjected to RLS on
-- tables that role owns. Only service_role is granted execute, mirroring that table's own
-- service_role-only grants: the Edge Function (via its service-role client) is the only caller,
-- exactly as before.
create or replace function public.check_and_record_coaching_message_request(
  p_user_id uuid,
  p_max_requests integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- Scoped to p_user_id only - concurrent requests from DIFFERENT users hash to different lock
  -- keys and never block each other; only two concurrent requests from the SAME user serialize.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select count(*)
    into v_count
    from coaching_message_requests
    where user_id = p_user_id
      and requested_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_max_requests then
    return false;
  end if;

  insert into coaching_message_requests (user_id) values (p_user_id);
  return true;
end;
$$;

revoke all on function public.check_and_record_coaching_message_request(uuid, integer, integer)
  from public;
grant execute on function public.check_and_record_coaching_message_request(uuid, integer, integer)
  to service_role;
