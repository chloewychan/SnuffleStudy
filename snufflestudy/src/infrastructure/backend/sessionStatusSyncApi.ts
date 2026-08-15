import { supabase } from "./supabaseClient";
import type { SessionEventType } from "../../domain/session/sessionTypes";

// The minimal event shape a friend is allowed to see, per the architecture overview's privacy
// example - only the columns session_status_events itself exposes (see
// supabase/migrations/20260815000001_v2_accountability_schema.sql), camelCased to match this
// codebase's TS conventions (see friendGroupApi.ts's identical row->interface mapping style).
// Nothing beyond what the table returns is invented here - richer per-field visibility (goal
// text, time remaining, current domain, etc. from docs/Draft1_Architecture_Overview.md's
// "Friend accountability" list) is Task 10's scope, not built yet.
export interface FriendEvent {
  id: string;
  userId: string;
  sessionId: string;
  type: SessionEventType;
  displayLabel: string;
  occurredAt: number;
}

interface SessionStatusEventRow {
  id: string;
  user_id: string;
  session_id: string;
  type: string;
  display_label: string;
  occurred_at: string;
}

// The exact, explicit column list queryEventsSince below must request - deliberately excludes
// hostname/goal_text (added by supabase/migrations/20260815000012_v2_privacy_controls.sql).
// Postgres RLS is row-level only: it cannot make those two columns differ per viewer on the same
// row, so the only real enforcement boundary for them is the dedicated SECURITY DEFINER RPC
// functions below (fetchFriendEventDetails/fetchFriendInterventionCount/fetchFriendFullHistory),
// never a bare `.select()` here. If this list is ever widened to include hostname/goal_text (or a
// future bare `.select()` is reintroduced), RLS would silently start returning the REAL values to
// every viewer this row is visible to at all - a serious regression, not just an unfinished
// feature. See sessionStatusSyncApi.test.ts's regression test asserting this exact string.
const BASELINE_EVENT_COLUMNS = "id, user_id, session_id, type, display_label, occurred_at";

// v2 Task 10: the per-field visibility toggles this schema now supports (goal text, current
// domain, intervention count, full history - see the migration above). "Time remaining" from the
// architecture doc's six-field privacy list is deliberately NOT built here or anywhere else in
// this codebase - controller-approved scope decision, documented in this task's report: it is an
// inherently live/streaming value, and this product's friend-activity delivery is event-based
// (Tasks 6-9, docs/Draft1_Architecture_Overview.md's "Friend-event delivery" section), not a
// streaming architecture a point-in-time "time remaining" value could be read from without a new
// delivery mechanism this task does not build.
export interface FriendEventDetails {
  id: string;
  hostname: string | null;
  goalText: string | null;
}

export interface FriendFullHistoryEvent {
  id: string;
  userId: string;
  sessionId: string;
  type: SessionEventType;
  displayLabel: string;
  hostname: string | null;
  goalText: string | null;
  occurredAt: number;
}

interface FriendEventDetailsRow {
  id: string;
  hostname: string | null;
  goal_text: string | null;
}

interface FriendFullHistoryRow {
  id: string;
  user_id: string;
  session_id: string;
  type: string;
  display_label: string;
  hostname: string | null;
  goal_text: string | null;
  occurred_at: string;
}

// Reads the current auth session via supabase.auth.getSession() rather than .getUser()
// (contrast friendGroupApi.ts's requireUserId(), which uses .getUser() for its explicit,
// infrequent user-initiated actions). getSession() reads the already-persisted/cached session
// through chromeStorageAuthAdapter without a dedicated round-trip to Supabase's Auth server in
// the common case (unlike .getUser(), which always makes one) - deliberate here because both
// functions below are called from v1's session lifecycle hot path (messageRouter.ts /
// alarmHandlers.ts, on every start/pause/resume/break/end/complete), where the Task 6 brief
// requires a signed-out user to pay "zero network cost" rather than merely catching a resulting
// error.
//
// `ok: false` (fix round 1) means the auth check itself failed - getSession() threw or returned
// an explicit error - as opposed to `ok: true, userId: null`, which means the check ran cleanly
// and simply found no session (a legitimate, expected "signed out" state). This distinction only
// matters to queryEventsSince/pollNewEventsForFriends below (which need to tell a real failure
// apart from "nothing to do" so alarmHandlers.ts's friend-poll alarm doesn't advance its cursor
// past a failure) - recordStatusEvent/fetchNewEventsForFriends still collapse both into a single
// no-op via currentUserId() below, since neither has a cursor to protect.
async function checkAuth(): Promise<{ ok: true; userId: string | null } | { ok: false }> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.error("Failed to read Supabase auth session", error);
      return { ok: false };
    }
    return { ok: true, userId: data.session?.user.id ?? null };
  } catch (err) {
    console.error("Failed to read Supabase auth session", err);
    return { ok: false };
  }
}

// Returns null (never throws) so callers can treat "not signed in" - and, per this function's
// contract, "the auth check itself failed" too - as a plain no-op. Used by recordStatusEvent and
// fetchNewEventsForFriends, neither of which needs to distinguish those two cases (see
// checkAuth's comment above).
async function currentUserId(): Promise<string | null> {
  const result = await checkAuth();
  return result.ok ? result.userId : null;
}

function toFriendEvent(row: SessionStatusEventRow): FriendEvent {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    type: row.type as SessionEventType,
    displayLabel: row.display_label,
    occurredAt: new Date(row.occurred_at).getTime(),
  };
}

// Inserts a session_status_events row for the current user. Never throws - v2's offline-first
// constraint ("a friend group feature failing to sync should never block starting or running a
// local session") means every call site in messageRouter.ts/alarmHandlers.ts treats this as
// fire-and-forget best-effort, but this function is defensive on its own terms too rather than
// relying purely on callers to catch it correctly.
// hostname/goalText (v2 Task 10) are optional and additive - display_label stays exactly what it
// already was (generic, non-identifying). Always written when the caller has the real value in
// scope at the call site (see friendSync.ts's recordFriendStatusEvent and its two callers in
// messageRouter.ts that now pass these) - per this task's brief, the read-side RLS/RPC redaction
// (see the BASELINE_EVENT_COLUMNS comment above and fetchFriendEventDetails below) is the actual
// enforcement boundary, not a write-time decision about what to send.
export async function recordStatusEvent(event: {
  type: SessionEventType;
  sessionId: string;
  displayLabel: string;
  hostname?: string;
  goalText?: string;
}): Promise<void> {
  try {
    const userId = await currentUserId();
    if (!userId) return; // Not signed in - sync is entirely opt-in/best-effort.

    const { error } = await supabase.from("session_status_events").insert({
      user_id: userId,
      session_id: event.sessionId,
      type: event.type,
      display_label: event.displayLabel,
      occurred_at: new Date().toISOString(),
      hostname: event.hostname ?? null,
      goal_text: event.goalText ?? null,
    });
    if (error) {
      console.error("Failed to record session status event", error);
    }
  } catch (err) {
    console.error("Failed to record session status event", err);
  }
}

// Shared implementation behind fetchNewEventsForFriends/pollNewEventsForFriends below.
// Deliberately unfiltered beyond the timestamp bound - server-side RLS (supabase/migrations/
// 20260815000002_v2_rls_policies.sql, "own session events always readable" + "group members can
// read visible friend session events") already restricts the result to the caller's own rows
// plus rows from group-mates who have send_live_nudges = true toward the caller, so the client
// trusts whatever comes back rather than re-deriving that visibility logic here.
//
// `ok` distinguishes "the check/query itself failed" (auth error, network error, query error -
// events is always [] in this case) from "it ran cleanly and found nothing new" - a cleanly
// resolved signed-out state is treated as the latter (ok: true, events: []): it's a legitimate,
// expected state for this function's direct callers (messageRouter.ts's FRIEND_EVENTS_FETCH,
// FriendGroupPanel.tsx), not a failure to retry. An auth check that itself failed (checkAuth's
// `ok: false`) is treated as a real failure, not "signed out" - collapsing those two would have
// hidden exactly the class of failure pollNewEventsForFriends's caller (alarmHandlers.ts's
// friend-poll alarm, fix round 1) needs to notice so it doesn't advance its cursor past it.
async function queryEventsSince(
  sinceTimestamp: number
): Promise<{ ok: boolean; events: FriendEvent[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, events: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, events: [] }; // Cleanly signed out - nothing to fetch, no-op.

    // Explicit narrowed column list (v2 Task 10) - see BASELINE_EVENT_COLUMNS's comment above for
    // why this must never widen to a bare `.select()` now that hostname/goal_text exist on this
    // table.
    const { data, error } = await supabase
      .from("session_status_events")
      .select(BASELINE_EVENT_COLUMNS)
      .gt("occurred_at", new Date(sinceTimestamp).toISOString())
      .order("occurred_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch friend session events", error);
      return { ok: false, events: [] };
    }
    return { ok: true, events: (data as SessionStatusEventRow[]).map(toFriendEvent) };
  } catch (err) {
    console.error("Failed to fetch friend session events", err);
    return { ok: false, events: [] };
  }
}

// Fetches session_status_events rows newer than sinceTimestamp. Never throws, and collapses the
// ok/events distinction above into a plain array (query failure and "no new events" both read as
// [] here) - this is the simpler contract this function's callers (messageRouter.ts's
// FRIEND_EVENTS_FETCH case, FriendGroupPanel.tsx) actually need: an on-demand UI fetch has no
// persisted cursor to protect from advancing incorrectly, so there's nothing for it to do
// differently on failure vs. "nothing new" - both just render as an empty/unchanged list.
export async function fetchNewEventsForFriends(sinceTimestamp: number): Promise<FriendEvent[]> {
  const result = await queryEventsSince(sinceTimestamp);
  return result.events;
}

// Poll-specific variant (v2 Task 6 fix round 1). alarmHandlers.ts's friend-poll alarm persists a
// "last checked" cursor (friendPollState.ts) and must only advance it on a *confirmed successful*
// poll - fetchNewEventsForFriends's plain `[]` return is indistinguishable between "genuinely no
// new events" and "the fetch itself failed" (network/query/auth error), and advancing the cursor
// on a silent failure would permanently lose any friend events that occurred during that outage
// window (the next poll would start counting from `now`, not from before the failure). Returning
// `ok` lets the caller leave the cursor untouched on failure so the next tick retries the same
// window instead.
export async function pollNewEventsForFriends(
  sinceTimestamp: number
): Promise<{ ok: boolean; events: FriendEvent[] }> {
  return queryEventsSince(sinceTimestamp);
}

// === v2 Task 10: per-field detail RPCs ===
//
// These three functions call supabase.rpc(...) instead of .from().select() - a deliberate
// deviation from this codebase's usual .select()-only convention (see friendGroupApi.ts/
// nudgeApi.ts/unlockRequestApi.ts/digestApi.ts, none of which use .rpc() for a client-facing
// read). It's necessary here, not stylistic: plain Postgres RLS is row-level only, so it cannot
// make hostname/goal_text differ per viewer on the SAME session_status_events row (one friend
// opted the subject into share_current_domain, another wasn't - RLS has no mechanism to hide a
// column from the second viewer while showing it to the first on one shared row). The
// SECURITY DEFINER RPC functions (supabase/migrations/20260815000012_v2_privacy_controls.sql)
// compute the redacted value server-side per caller instead - the only way to keep this a real
// server-side guarantee rather than shipping the real value to every client and trusting it not
// to render it.

// Looks up hostname/goal_text for event ids the caller already legitimately received from
// fetchNewEventsForFriends/pollNewEventsForFriends above (those already prove row-visibility via
// the narrowed baseline query). The RPC independently re-verifies visibility for each id anyway
// (defense-in-depth against a malicious client passing arbitrary/guessed ids) and returns each
// field independently null'd per the subject's share_current_domain/share_goal_text toggle toward
// the caller - see that migration's fetch_friend_event_details for the exact redaction logic.
export async function fetchFriendEventDetails(eventIds: string[]): Promise<FriendEventDetails[]> {
  if (eventIds.length === 0) return [];
  try {
    const { data, error } = await supabase.rpc("fetch_friend_event_details", {
      p_event_ids: eventIds,
    });
    if (error || !data) {
      console.error("Failed to fetch friend event details", error);
      return [];
    }
    return (data as FriendEventDetailsRow[]).map((row) => ({
      id: row.id,
      hostname: row.hostname,
      goalText: row.goal_text,
    }));
  } catch (err) {
    console.error("Failed to fetch friend event details", err);
    return [];
  }
}

// Aggregate count of a friend's DISTRACTION_ATTEMPT events, gated by share_intervention_count
// (plus the group-membership floor) - see fetch_friend_intervention_count. Returns null (never
// throws) on denial or any other failure - the RPC itself raises a Postgres exception when the
// caller isn't authorized, which this function treats the same as any other failure: omit the
// field, don't surface the raw database error to a UI.
export async function fetchFriendInterventionCount(
  subjectUserId: string,
  since?: number
): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("fetch_friend_intervention_count", {
      p_subject_user_id: subjectUserId,
      p_since: since != null ? new Date(since).toISOString() : null,
    });
    if (error || data == null) {
      console.error("Failed to fetch friend intervention count", error);
      return null;
    }
    return data as number;
  } catch (err) {
    console.error("Failed to fetch friend intervention count", err);
    return null;
  }
}

// A friend's ENTIRE session_status_events history (not just recent/unseen-since-poll), gated by
// share_full_history (plus the group-membership floor) - see fetch_friend_full_history. Like
// fetch_friend_intervention_count, this RPC raises on denial rather than returning an empty
// result, so a denial and a genuinely-empty-but-authorized history are distinguishable - this
// function collapses both into [] (never throws) since none of this codebase's existing
// fetch*-for-UI functions distinguish "denied" from "empty" at this layer either (see
// fetchNewEventsForFriends/fetchIncomingNudges's identical convention).
export async function fetchFriendFullHistory(subjectUserId: string): Promise<FriendFullHistoryEvent[]> {
  try {
    const { data, error } = await supabase.rpc("fetch_friend_full_history", {
      p_subject_user_id: subjectUserId,
    });
    if (error || !data) {
      console.error("Failed to fetch friend full history", error);
      return [];
    }
    return (data as FriendFullHistoryRow[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      type: row.type as SessionEventType,
      displayLabel: row.display_label,
      hostname: row.hostname,
      goalText: row.goal_text,
      occurredAt: new Date(row.occurred_at).getTime(),
    }));
  } catch (err) {
    console.error("Failed to fetch friend full history", err);
    return [];
  }
}
