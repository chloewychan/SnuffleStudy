-- v2 Task 9: Daily accountability digest.
--
-- Deviation from the plan's literal wording (documented here and in this task's report): the
-- plan calls for "A scheduled Supabase Edge Function (daily)". Deploying an actual Deno Edge
-- Function requires the Supabase CLI linked via a personal access token, which is not available
-- in this environment (only the project URL, anon key, service-role key, and DB password are
-- configured). The controller confirmed directly that this project has the pg_cron and pg_net
-- extensions available and successfully created both via a direct Postgres connection. This
-- migration uses pg_cron to schedule a SECURITY DEFINER Postgres function instead of a Deno Edge
-- Function - functionally identical outcome ("scheduled daily aggregation"), different
-- implementation mechanism, chosen because it's the tooling actually available here. Nothing
-- about digestApi.ts, the RLS model, or the DoD changes as a result of this substitution.
--
-- daily_digests: one row per (subject_user_id, digest_date) - the primary key itself is what
-- guarantees "a friend sees one summary per day, not per session" (this task's DoD): there is
-- structurally no way for more than one row to exist for the same user on the same day, no
-- matter how many times compute_daily_digests() below runs or how many sessions happened that
-- day.
create table daily_digests (
  subject_user_id     uuid not null references auth.users(id),
  digest_date          date not null,
  completed_sessions   integer not null default 0,
  abandoned_sessions   integer not null default 0,
  distraction_count    integer not null default 0,
  recovery_rate        real not null default 0,
  computed_at          timestamptz not null default now(),
  primary key (subject_user_id, digest_date)
);

alter table daily_digests enable row level security;

-- Grants follow 20260815000003's lesson directly (Bug 1 there: `enable row level security` alone
-- does not grant the underlying SQL-level privilege - Postgres checks GRANTs before it ever
-- considers RLS policies, so a table with RLS enabled but no GRANT denies everyone outright,
-- never reaching a policy at all). `authenticated` gets SELECT only - deliberately no INSERT/
-- UPDATE/DELETE grant at all, which is a stronger guarantee than "no policy for it" alone: even
-- if a future migration accidentally added a permissive INSERT/UPDATE/DELETE policy for
-- `authenticated`, the write would still be rejected at the GRANT level first. This table must
-- only ever be written by compute_daily_digests() below (SECURITY DEFINER, runs as this
-- migration's owning role) or directly by the service role (verify-digest.mjs's cleanup), never
-- by a client.
grant select on daily_digests to authenticated;
grant select, insert, update, delete on daily_digests to service_role;

-- friend_has_granted_digest_visibility: mirrors friend_has_granted_live_visibility's structure
-- exactly (supabase/migrations/20260815000006_v2_fix_session_status_events_visibility_recursion.sql
-- - SECURITY DEFINER exists() check over friendship_settings, same cross-table-recursion fix
-- shape), but checks the VIEWER's own row rather than the subject's own row. This is a deliberate
-- judgment call, not a typo, documented here because "mirror it exactly" could be misread as
-- "same row positions, just swap the column name":
--
-- friend_has_granted_live_visibility checks the OWNER's row (user_id = owner, friend_user_id =
-- viewer, send_live_nudges = true) because send_live_nudges is the OWNER's own declared
-- preference ("I will send my live status to this friend") - the data owner controls visibility
-- of their own data, which is this codebase's established privacy model.
--
-- friendship_settings has no equivalent "send_daily_digest" column - Task 5's schema (fixed,
-- transcribed from the plan, not something this task may rename/retype) has only
-- receive_daily_digest. Every other "receive_*" column in this table already has an established,
-- already-shipped-and-tested meaning: receive_live_nudges is read in can_send_nudge()
-- (20260815000007_v2_nudges.sql) as the RECIPIENT's own row ("select receive_live_nudges ... from
-- friendship_settings where user_id = p_recipient_user_id and friend_user_id = p_sender_user_id")
-- - i.e. MY OWN preference, on MY OWN row, to receive something FROM a specific friend. By that
-- same, already-proven-live naming convention, receive_daily_digest must mean the same thing:
-- MY OWN preference, on MY OWN row, to receive a digest ABOUT a specific friend. So the row this
-- function must check is the VIEWER's row (user_id = viewer, friend_user_id = subject), not the
-- subject's row.
--
-- This also matches Task 9's own Definition of Done in plain English: "a friend who opted into
-- digests ... sees one summary per day" - the friend (viewer) is the one whose own opt-in
-- determines what THEY see, exactly as this function implements it.
create or replace function public.friend_has_granted_digest_visibility(
  p_subject_user_id uuid,
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
    where user_id = p_viewer_user_id
      and friend_user_id = p_subject_user_id
      and receive_daily_digest = true
  );
$$;

revoke all on function public.friend_has_granted_digest_visibility(uuid, uuid) from public;
grant execute on function public.friend_has_granted_digest_visibility(uuid, uuid)
  to authenticated, service_role;

-- Only a SELECT policy, per this task's brief - no INSERT/UPDATE/DELETE policy for `authenticated`
-- at all (this table is never written by a client - see the GRANT comment above for the
-- defense-in-depth reasoning).
create policy "subject or digest-opted-in friend can read a daily digest"
  on daily_digests for select
  using (
    subject_user_id = auth.uid()
    or friend_has_granted_digest_visibility(daily_digests.subject_user_id, auth.uid())
  );

-- compute_daily_digests: the SECURITY DEFINER aggregation function pg_cron schedules below.
-- Aggregates session_status_events (Task 5/6) for target_date (default: yesterday, so a full
-- day's data is always available by the time this runs) into one upserted daily_digests row per
-- user who had at least one event that day - the `group by user_id` over a `target_date`-filtered
-- FROM session_status_events naturally restricts the result to exactly those users, with no
-- separate "does this user have any events today" existence check needed.
--
-- Zero-distraction convention (recovery_rate's divide-by-zero guard): a user with ZERO
-- DISTRACTION_ATTEMPT events that day has nothing to recover from, so this treats that day as
-- fully-recovered (recovery_rate = 1.0) rather than 0 or NaN - 0 would read as "never recovered",
-- which is misleading/unfair for a day with no distractions at all; NaN would be a real bug
-- (division by zero). This is a documented judgment call, not the only defensible choice - a
-- reviewer could reasonably prefer 0 or null instead - but 1.0 is the one chosen here and is what
-- scripts/verify-digest.mjs asserts against.
--
-- SECURITY DEFINER lets this bypass daily_digests' own RLS (which has no INSERT/UPDATE policy for
-- any role) to actually write the upserted rows - the same pattern this codebase already uses
-- throughout (is_group_member, has_redeemed_invite_code, friend_has_granted_live_visibility,
-- can_send_nudge), just applied here to a data-writing aggregation instead of a read-side
-- visibility check.
create or replace function public.compute_daily_digests(target_date date default (current_date - 1))
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into daily_digests (
    subject_user_id,
    digest_date,
    completed_sessions,
    abandoned_sessions,
    distraction_count,
    recovery_rate,
    computed_at
  )
  select
    sse.user_id,
    target_date,
    count(*) filter (where sse.type = 'SESSION_COMPLETED')::integer,
    count(*) filter (where sse.type = 'SESSION_ABANDONED')::integer,
    count(*) filter (where sse.type = 'DISTRACTION_ATTEMPT')::integer,
    case
      when count(*) filter (where sse.type = 'DISTRACTION_ATTEMPT') = 0 then 1.0
      else count(*) filter (where sse.type = 'RECOVERY')::real
           / count(*) filter (where sse.type = 'DISTRACTION_ATTEMPT')::real
    end,
    now()
  from session_status_events sse
  where sse.occurred_at >= target_date::timestamptz
    and sse.occurred_at < (target_date + 1)::timestamptz
  group by sse.user_id
  on conflict (subject_user_id, digest_date) do update set
    completed_sessions = excluded.completed_sessions,
    abandoned_sessions = excluded.abandoned_sessions,
    distraction_count = excluded.distraction_count,
    recovery_rate = excluded.recovery_rate,
    computed_at = excluded.computed_at;
end;
$$;

-- Deliberately NOT granted to `authenticated` - this is a privileged aggregation/write function,
-- never meant to be called by a client (only pg_cron's scheduled job, which runs as the role that
-- registered it - here, the migration-running superuser, which needs no explicit grant - and
-- scripts/verify-digest.mjs's service-role client, which invokes it directly via RPC for live
-- verification since the test can't wait for the real daily schedule to fire).
revoke all on function public.compute_daily_digests(date) from public;
grant execute on function public.compute_daily_digests(date) to service_role;

-- Schedule: pg_cron, per this migration's header comment. 00:05 UTC daily - comfortably after
-- midnight so `current_date - 1`'s full day of session_status_events has definitely landed, and
-- an off-the-hour minute to avoid colliding with other cron jobs that commonly default to :00.
-- Exact minute/hour is not load-bearing - any once-daily schedule satisfies this task's DoD.
create extension if not exists pg_cron;

select cron.schedule('compute-daily-digests', '5 0 * * *', $$ select compute_daily_digests(); $$);
