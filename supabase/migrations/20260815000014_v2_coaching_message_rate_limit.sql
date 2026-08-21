-- v2 Task 11: Dynamic Coach Coaching Messages - per-user rate limiting for the
-- generate-coaching-message Edge Function.
--
-- This table exists purely as a request-timestamp ledger the Edge Function uses to enforce a
-- sliding-window rate limit (see supabase/functions/generate-coaching-message/index.ts) - it is
-- never read or written by any client-side code (coachingApi.ts calls the Edge Function via
-- supabase.functions.invoke(...), never touches this table directly). Per this task's brief:
-- "no RLS policies needed for client access since only the Edge Function (using the service-role
-- key, auto-injected into every Edge Function's environment as SUPABASE_SERVICE_ROLE_KEY) ever
-- touches this table."
--
-- RLS is still enabled (matching every other table in this schema since 20260815000001) as
-- defense-in-depth, and no policies are defined - an authenticated/anon role therefore has zero
-- access regardless. Grants are scoped to service_role only (not authenticated/anon), unlike
-- every other table in this schema (which grants both) - the Bug 1 lesson from
-- 20260815000003 (enabling RLS alone does not grant the underlying SQL-level privilege) applies
-- here too, so the grant is explicit, just narrower than usual since this table has no
-- client-facing CRUD surface at all.
create table coaching_message_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  requested_at  timestamptz not null default now()
);

-- Supports the Edge Function's per-user sliding-window count query
-- ("... where user_id = $1 and requested_at > now() - interval '60 seconds'") efficiently -
-- without this, that query is a sequential scan over the whole table on every single
-- distraction-event call, the exact hot path this rate limiter exists to protect.
create index coaching_message_requests_user_id_requested_at_idx
  on coaching_message_requests (user_id, requested_at desc);

alter table coaching_message_requests enable row level security;

grant select, insert, delete on coaching_message_requests to service_role;
