import { supabase } from "./supabaseClient";
import { checkAuth } from "./authHelpers";

// subject_user_id (the daily_digests column - see supabase/migrations/
// 20260815000010_v2_daily_digests.sql) is mapped to friendUserId here, matching this file's own
// row->interface camelCase convention (sessionStatusSyncApi.ts's FriendEvent and nudgeApi.ts's
// FriendNudge do the same).
export interface DigestSummary {
  friendUserId: string;
  completedSessions: number;
  abandonedSessions: number;
  distractionCount: number;
  recoveryRate: number;
}

// Richer than DigestSummary (adds digestDate/computedAt) - needed by alarmHandlers.ts's
// poll-side delivery, which must know WHICH digest-day a row is for (to render it in a
// notification and to key the "already notified for this day" dedupe) and WHEN it was computed
// (used as this stream's poll cursor, the same way other streams use occurred_at/sent_at - see
// friendPollState.ts). fetchDigestForDate below intentionally returns the narrower DigestSummary
// shape only.
export interface FriendDigest extends DigestSummary {
  digestDate: string; // YYYY-MM-DD
  computedAt: number;
}

interface DailyDigestRow {
  subject_user_id: string;
  digest_date: string;
  completed_sessions: number;
  abandoned_sessions: number;
  distraction_count: number;
  recovery_rate: number;
  computed_at: string;
}

function toFriendDigest(row: DailyDigestRow): FriendDigest {
  return {
    friendUserId: row.subject_user_id,
    completedSessions: row.completed_sessions,
    abandonedSessions: row.abandoned_sessions,
    distractionCount: row.distraction_count,
    recoveryRate: row.recovery_rate,
    digestDate: row.digest_date,
    computedAt: new Date(row.computed_at).getTime(),
  };
}

// Shared implementation behind fetchDigestForDate below - deliberately unfiltered beyond the
// digest_date bound (like sessionStatusSyncApi's queryEventsSince) - server-side RLS
// (daily_digests' "subject or digest-opted-in friend can read a daily digest" policy, supabase/
// migrations/20260815000010_v2_daily_digests.sql) already restricts the result to the caller's
// own row (if one exists for that date) plus rows from friends who set
// receive_daily_digest = true toward the caller - the client trusts whatever comes back rather
// than re-deriving that visibility logic here.
async function queryDigestsForDate(
  date: string
): Promise<{ ok: boolean; digests: FriendDigest[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, digests: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, digests: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const { data, error } = await supabase
      .from("daily_digests_visible")
      .select()
      .eq("digest_date", date)
      .order("subject_user_id", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch daily digests", error);
      return { ok: false, digests: [] };
    }
    return { ok: true, digests: (data as DailyDigestRow[]).map(toFriendDigest) };
  } catch (err) {
    console.error("Failed to fetch daily digests", err);
    return { ok: false, digests: [] };
  }
}

// Fetches the digest(s) for a specific calendar date (YYYY-MM-DD) - used by
// messageRouter.ts's DIGEST_FETCH (FriendGroupPanel.tsx's on-demand display fetch). Never throws,
// and collapses the ok/digests distinction into a plain array - a UI fetch has no persisted
// cursor to protect, so there's nothing to do differently on failure vs. "nothing for this date".
//
// Includes the caller's OWN row if RLS returns one for that date, rather than filtering it out
// here. It genuinely represents the caller's own stats for that date, which is a legitimate,
// useful thing to hand back - the panel (FriendGroupPanel.tsx) is free to filter it out for a
// "friends only" view, but this fetch itself returns exactly what RLS allows.
export async function fetchDigestForDate(date: string): Promise<DigestSummary[]> {
  const result = await queryDigestsForDate(date);
  return result.digests.map((d) => ({
    friendUserId: d.friendUserId,
    completedSessions: d.completedSessions,
    abandonedSessions: d.abandonedSessions,
    distractionCount: d.distractionCount,
    recoveryRate: d.recoveryRate,
  }));
}

// Poll-specific variant for alarmHandlers.ts's friend-poll alarm - returns a discriminated result
// so the alarm only advances its persisted "last checked for digests" cursor
// (friendPollState.ts) on a confirmed successful poll, leaving it untouched on failure so the next
// tick retries the same window instead of silently and permanently dropping a digest
// notification.
//
// Filtered by computed_at (not digest_date) across ALL dates, unlike queryDigestsForDate above -
// this is the delivery-side query ("what digest rows are new since I last checked"), not a
// specific-date display query. Since compute_daily_digests() upserts exactly one row per
// (subject_user_id, digest_date) - see the migration - a friend's digest row is only ever "new"
// (computed_at advances past the cursor) once per day it's computed, which is what keeps delivery
// to one summary per day per friend, without alarmHandlers.ts needing to separately track which
// dates it has already shown.
export async function pollNewDigests(
  sinceTimestamp: number
): Promise<{ ok: true; digests: FriendDigest[] } | { ok: false }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, digests: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const { data, error } = await supabase
      .from("daily_digests_visible")
      .select()
      .gt("computed_at", new Date(sinceTimestamp).toISOString())
      .order("computed_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to poll daily digests", error);
      return { ok: false };
    }
    return { ok: true, digests: (data as DailyDigestRow[]).map(toFriendDigest) };
  } catch (err) {
    console.error("Failed to poll daily digests", err);
    return { ok: false };
  }
}
