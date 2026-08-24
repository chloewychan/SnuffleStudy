import { supabase } from "./supabaseClient";
import type { SessionEndRequest } from "../../domain/accountability/sessionEndRequest";

// v3.3 Task 12: mirrors unlockRequestApi.ts's shape exactly (see that file's own header comment
// for the full rationale this file reuses without re-deriving) - session_end_requests reuses
// unlock_requests' exact RLS shape per Decision 1 (docs/implementation_plans/
// V3.3_Implementation_Plan.md), so the client-side API mirrors it too: same requireUserId()+throw
// convention for createRequest/resolveRequest, same checkAuth()-gated queryRelevantSince split for
// fetch/poll, same reasons for both.

interface SessionEndRequestRow {
  id: string;
  session_id: string;
  requester_user_id: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function toSessionEndRequest(row: SessionEndRequestRow): SessionEndRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    requesterUserId: row.requester_user_id,
    status: row.status as SessionEndRequest["status"],
    requestedAt: new Date(row.requested_at).getTime(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null,
    resolvedBy: row.resolved_by,
  };
}

// Mirrors unlockRequestApi.ts's checkAuth() exactly (same ok:false-means-the-check-itself-failed
// vs. ok:true/userId:null-means-cleanly-signed-out distinction) - queryRelevantSince below is the
// poll-side function that needs to tell a real failure apart from "nothing to do" so
// alarmHandlers.ts's friend-poll alarm doesn't advance its session-end-request cursor past a
// failure.
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

// Mirrors unlockRequestApi.ts's requireUserId() exactly - see that file's own comment for why
// .getUser() (not .getSession()) is used here: these are explicit, infrequent user-initiated
// actions (a request/approve/deny button press), not a hot-path lifecycle transition.
async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Creates a pending session-end request for the given session, as the current user. Group
// notification is NOT a separate write here, for the identical reason unlockRequestApi.ts's
// createRequest documents: any group member sharing a group with the requester can already see
// this row the instant it's inserted, via session_end_requests' "requester resolver or
// pending-group-member can read session-end requests" RLS policy (supabase/migrations/
// 20260815000038_v3.3_session_end_requests.sql). alarmHandlers.ts's friend-poll alarm is what
// turns that visibility into an actual chrome.notifications toast on a friend's device.
export async function createRequest(sessionId: string): Promise<SessionEndRequest> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from("session_end_requests")
    .insert({
      session_id: sessionId,
      requester_user_id: userId,
      status: "pending",
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create session-end request.");
  }

  return toSessionEndRequest(data as SessionEndRequestRow);
}

// Resolves (approves or denies) a pending session-end request as the current user.
//
// Deliberately chains .select().single() after the update, for the exact "first responder wins"
// reason unlockRequestApi.ts's resolveRequest documents at length: an UPDATE matching zero rows is
// not itself a Postgres/PostgREST error, which is exactly what happens when a second friend
// attempts to resolve a request another friend already resolved a moment earlier (the UPDATE
// policy's USING clause requires status = 'pending' for a non-requester - supabase/migrations/
// 20260815000038_v3.3_session_end_requests.sql). Without forcing a `.single()` read of the (now
// zero) affected rows, this function would resolve successfully with no error and no data.
export async function resolveRequest(
  requestId: string,
  decision: "approved" | "denied"
): Promise<void> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from("session_end_requests")
    .update({
      status: decision,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
    })
    .eq("id", requestId)
    .select()
    .single();
  if (error || !data) {
    throw new Error(
      error?.message ?? "Could not resolve this request — it may already have been resolved."
    );
  }
}

// Shared implementation behind fetchRelevantSessionEndRequests/pollRelevantSessionEndRequests
// below - same split/rationale as unlockRequestApi.ts's identical queryRelevantSince: `ok`
// distinguishes "the query itself failed" from "it ran cleanly and found nothing new", which only
// matters to the poll-side caller (alarmHandlers.ts's friend-poll alarm, which must not advance
// its persisted session-end-request cursor past a failure).
//
// Deliberately unfiltered beyond the timestamp bound - server-side RLS (supabase/migrations/
// 20260815000038_v3.3_session_end_requests.sql) already restricts the result to: the caller's own
// requests (any status), requests the caller resolved (any status), and PENDING requests from
// anyone sharing a group with the caller. The client trusts whatever comes back rather than
// re-deriving that visibility logic here.
async function queryRelevantSince(
  sinceTimestamp: number
): Promise<{ ok: boolean; requests: SessionEndRequest[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, requests: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, requests: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const sinceIso = new Date(sinceTimestamp).toISOString();
    const { data, error } = await supabase
      .from("session_end_requests")
      .select()
      .or(`requested_at.gt.${sinceIso},resolved_at.gt.${sinceIso}`)
      .order("requested_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch session-end requests", error);
      return { ok: false, requests: [] };
    }
    return { ok: true, requests: (data as SessionEndRequestRow[]).map(toSessionEndRequest) };
  } catch (err) {
    console.error("Failed to fetch session-end requests", err);
    return { ok: false, requests: [] };
  }
}

// On-demand fetch for SessionEndRequestPanel.tsx/EndSessionControl.tsx (via messageRouter.ts's
// SESSION_END_REQUESTS_FETCH) - collapses the ok/requests distinction into a plain array,
// mirroring fetchRelevantUnlockRequests's identical contract: a UI fetch has no persisted cursor
// to protect, so there's nothing to do differently on failure vs. "nothing new" - both just render
// as an empty/unchanged list.
export async function fetchRelevantSessionEndRequests(
  sinceTimestamp: number
): Promise<SessionEndRequest[]> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.requests;
}

// Poll-specific variant for alarmHandlers.ts's friend-poll alarm - mirrors
// pollRelevantUnlockRequests's discriminated result exactly, so the alarm only advances its
// persisted "last checked for session-end requests" cursor (friendPollState.ts) on a confirmed
// successful poll, leaving it untouched on failure so the next tick retries the same window
// instead of silently and permanently dropping a pending request notification or an
// approval/denial.
export async function pollRelevantSessionEndRequests(
  sinceTimestamp: number
): Promise<{ ok: true; requests: SessionEndRequest[] } | { ok: false }> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.ok ? { ok: true, requests: result.requests } : { ok: false };
}

// Security-critical - see this task's report and supabase/migrations/
// 20260815000038_v3.3_session_end_requests.sql's own header comment for the full reasoning this
// comment summarizes.
//
// Does its own fresh read of the request row (never trusts a client-supplied status/sessionId the
// way Decision 3, docs/implementation_plans/V3.3_Implementation_Plan.md, already establishes for
// TEMP_PASSCODE_CLAIM_APPROVAL), and returns true only if ALL THREE hold: the row is actually
// approved, the row's session_id matches the session the caller is trying to end, AND the row's
// requester_user_id matches the CALLER's own id.
//
// That third check is the one doing the real work here, and it matters beyond what RLS alone
// guarantees. RLS's "requester resolver or pending-group-member can read session-end requests"
// policy deliberately lets the RESOLVING FRIEND read this row too (via `resolved_by = auth.uid()`)
// - that's by design, so a friend can see the outcome of a request they just approved. But read
// access is not the same thing as "this pass is mine to use." Without this explicit
// requester_user_id comparison, a friend who approved someone else's session-end request could
// take that same approved requestId, pass it into their own SESSION_END call, and end their OWN
// session early with a pass that was never granted to them - RLS would happily let them read the
// row (they're allowed to, as the resolver), and nothing else would stop them. Comparing
// requester_user_id against the caller's own freshly-verified identity (requireUserId(), not a
// client-supplied field) is what closes that gap. Verified directly, live, with two real accounts:
// sign in as the resolving friend and call this with the requester's endRequestId - it returns
// false.
export async function isApprovedForSelf(requestId: string, sessionId: string): Promise<boolean> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from("session_end_requests")
    .select("session_id, status, requester_user_id")
    .eq("id", requestId)
    .single();
  if (error || !data) return false;

  return data.status === "approved" && data.session_id === sessionId && data.requester_user_id === userId;
}
