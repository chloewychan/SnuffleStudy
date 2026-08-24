-- v3.2 Task 5: Daily-digest privacy enforcement.
--
-- Bug: `distraction_count` in daily_digests currently ignores
-- friendship_settings.share_distraction_attempts entirely. compute_daily_digests()
-- (20260815000010_v2_daily_digests.sql) aggregates DISTRACTION_ATTEMPT counts unconditionally
-- into the stored row, and digestApi.ts's two reads (queryDigestsForDate/pollNewDigests) select
-- straight from daily_digests - so a subject who has never granted a specific friend
-- share_distraction_attempts (added by 20260815000012_v2_privacy_controls.sql, default false)
-- still has their real distraction_count exposed to that friend via the digest, the moment
-- daily_digests' own row-level RLS ("subject or digest-opted-in group-mate can read a daily
-- digest", 20260815000011) lets them see the row at all. This directly contradicts
-- session_status_events' own DISTRACTION_ATTEMPT-type gate (20260815000012's
-- friend_has_granted_distraction_visibility, consulted by that table's own SELECT policy) -
-- distraction data is supposed to be gated by this exact toggle everywhere it appears, and the
-- digest was the one place that gate was never wired in.
--
-- Narrower than docs/V3.2_Scope_Summary.md's original phrasing ("goal text and distraction
-- attempts") - see docs/implementation_plans/V3.2_Implementation_Plan.md's Decisions 2-3.
-- daily_digests has no goal-text column at all (it's four aggregate numbers -
-- completed_sessions/abandoned_sessions/distraction_count/recovery_rate - never per-session
-- detail), and of those four, only distraction_count has a corresponding Task 10 toggle that
-- isn't currently consulted. Confirmed directly against the live schema before writing this
-- migration: daily_digests' columns (subject_user_id uuid, digest_date date, completed_sessions
-- integer, abandoned_sessions integer, distraction_count integer, recovery_rate real,
-- computed_at timestamptz) and friendship_settings.share_distraction_attempts (boolean, added by
-- 20260815000012) match this migration's view definition exactly - no column-name/type
-- adjustment was needed against the plan's literal SQL.
--
-- Why a view rather than fanning storage out into a per-(subject, viewer, date) row: daily_digests
-- stores one row per (subject_user_id, digest_date) - its primary key is what guarantees "one
-- summary per day, not per session" (20260815000010's own DoD). "Hide distraction_count from
-- viewer B but show it to viewer A" can't be a stored-row property without breaking that
-- invariant, so this computes per-viewer visibility at read time via auth.uid() instead - cheaper,
-- and the same pattern this codebase already uses for row-level visibility (a SECURITY DEFINER
-- helper/exists() check consulted inside a policy), just applied here to a single column instead
-- of a whole row.
--
-- security_invoker (Postgres's default for CREATE VIEW, unchanged here) means this view runs with
-- the querying user's own permissions and is subject to daily_digests' own RLS on the underlying
-- table exactly as if queried directly - so the existing "subject or digest-opted-in group-mate"
-- policy still gates ROW access precisely as it does today (a viewer who isn't the subject and
-- doesn't have a shared-group + receive_daily_digest opt-in never sees a row via this view either).
-- This view only narrows what's exposed in the distraction_count COLUMN for a row the viewer can
-- already see - it does not need to re-derive the group-membership floor itself, since a row only
-- reaches this view's CASE expression at all once daily_digests' base-table RLS has already
-- allowed it through.
--
-- distraction_count folds to 0 (not null) for a viewer who hasn't been granted
-- share_distraction_attempts, matching compute_daily_digests()'s own already-documented
-- zero-distraction convention (a real, valid 0 - see that migration's comment on recovery_rate's
-- divide-by-zero guard) rather than introducing a new "hidden" sentinel value that would force
-- every downstream consumer to distinguish "really zero" from "redacted".
--
-- completed_sessions, abandoned_sessions, and recovery_rate pass through unchanged - none of them
-- has a corresponding Task 10 per-field toggle yet, so there is nothing to gate; if one is added
-- later, this view is exactly where it would be added the same way.
create or replace view public.daily_digests_visible as
select
  d.subject_user_id,
  d.digest_date,
  d.completed_sessions,
  d.abandoned_sessions,
  case
    when d.subject_user_id = auth.uid() then d.distraction_count
    when exists (
      select 1 from friendship_settings fs
      where fs.user_id = d.subject_user_id
        and fs.friend_user_id = auth.uid()
        and fs.share_distraction_attempts = true
    ) then d.distraction_count
    else 0
  end as distraction_count,
  d.recovery_rate,
  d.computed_at
from public.daily_digests d;

-- Matches daily_digests' own grant shape (20260815000010: `authenticated` gets SELECT only, never
-- INSERT/UPDATE/DELETE - this is a read-side view over an already-write-locked table, so there is
-- nothing else to grant).
grant select on public.daily_digests_visible to authenticated;
