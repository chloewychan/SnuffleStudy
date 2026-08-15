import { supabase } from "./supabaseClient";

// v2 Task 8 owns this type directly (no domain/ file) - following Task 5/6/7's precedent
// (FriendEvent in sessionStatusSyncApi.ts, FriendNudge in nudgeApi.ts) of defining task-owned
// backend types in their API file rather than a separate domain/ module.
export type UnlockRequestStatus = "pending" | "approved" | "denied";

export interface UnlockRequest {
  id: string;
  sessionId: string;
  requesterUserId: string;
  hostname: string;
  status: UnlockRequestStatus;
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

interface UnlockRequestRow {
  id: string;
  session_id: string;
  requester_user_id: string;
  hostname: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function toUnlockRequest(row: UnlockRequestRow): UnlockRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    requesterUserId: row.requester_user_id,
    hostname: row.hostname,
    status: row.status as UnlockRequestStatus,
    requestedAt: new Date(row.requested_at).getTime(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null,
    resolvedBy: row.resolved_by,
  };
}

// Mirrors sessionStatusSyncApi.ts's/nudgeApi.ts's checkAuth() exactly (same
// ok:false-means-the-check-itself-failed vs. ok:true/userId:null-means-cleanly-signed-out
// distinction) - queryRelevantSince below is the poll-side function that needs to tell a real
// failure apart from "nothing to do" so alarmHandlers.ts's friend-poll alarm doesn't advance its
// unlock-request cursor past a failure.
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

// createRequest/resolveRequest mirror friendGroupApi.ts's requireUserId()+throw convention (not
// nudgeApi.sendNudge's ok/error discriminated-result convention) - the brief's own declared
// signatures are plain Promise<UnlockRequest>/Promise<void>, matching createGroup()'s shape, not
// sendNudge()'s. Uses .getUser() (not .getSession(), unlike checkAuth() above) for the same
// reason friendGroupApi.ts's requireUserId() does: these are explicit, infrequent
// user-initiated actions (a request/approve/deny button press), not a hot-path lifecycle
// transition, so paying getUser()'s extra round trip for a verified identity is fine here.
async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Creates a pending unlock request for the given session/hostname, as the current user. Group
// notification is NOT a separate write here - any group member sharing a group with the
// requester can already see this row the instant it's inserted, via unlock_requests' "requester
// resolver or pending-group-member can read unlock requests" RLS policy (supabase/migrations/
// 20260815000008_v2_unlock_request_group_visibility.sql) - alarmHandlers.ts's friend-poll alarm
// (reused from Task 6, not a new delivery path) is what turns that visibility into an actual
// chrome.notifications toast on a friend's device.
export async function createRequest(sessionId: string, hostname: string): Promise<UnlockRequest> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from("unlock_requests")
    .insert({
      session_id: sessionId,
      requester_user_id: userId,
      hostname,
      status: "pending",
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create unlock request.");
  }

  return toUnlockRequest(data as UnlockRequestRow);
}

// Resolves (approves or denies) a pending unlock request as the current user.
//
// Deliberately chains .select().single() after the update rather than a bare
// .update(...).eq("id", requestId) - an UPDATE statement that matches zero rows is NOT a
// Postgres/PostgREST error on its own (it just silently affects nothing), and that's exactly
// what happens when a second friend attempts to resolve a request another friend already
// resolved a moment earlier: the new UPDATE policy's USING clause requires `status = 'pending'`
// for a non-requester (supabase/migrations/20260815000008_v2_unlock_request_group_visibility.sql),
// so the row is silently excluded rather than erroring. Without forcing a `.single()` read of the
// (now zero) affected rows, this function would resolve successfully with no error and no data -
// i.e. it would silently report success on a request that was, in fact, NOT resolved by this
// call - the opposite of the "first responder wins" guarantee this task's brief requires ("a
// second friend attempting to resolve the same (now non-pending) request must be denied").
// `.single()` on zero returned rows surfaces as a real Postgrest error (no row / multiple rows
// expected), which is thrown below like any other failure.
export async function resolveRequest(
  requestId: string,
  decision: "approved" | "denied"
): Promise<void> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from("unlock_requests")
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

// Shared implementation behind fetchRelevantUnlockRequests/pollRelevantUnlockRequests below -
// same split/rationale as sessionStatusSyncApi.ts's queryEventsSince and nudgeApi.ts's
// queryNudgesSince: `ok` distinguishes "the query itself failed" from "it ran cleanly and found
// nothing new", which only matters to the poll-side caller (alarmHandlers.ts's friend-poll
// alarm, which must not advance its persisted unlock-request cursor past a failure - the same
// fix-round-1 discipline Task 6 had to add after the fact, built in here from the start).
//
// Deliberately unfiltered beyond the timestamp bound (like sessionStatusSyncApi's
// queryEventsSince) - server-side RLS (supabase/migrations/
// 20260815000008_v2_unlock_request_group_visibility.sql) already restricts the result to: the
// caller's own requests (any status), requests the caller resolved (any status), and PENDING
// requests from anyone sharing a group with the caller. The client trusts whatever comes back
// rather than re-deriving that visibility logic here.
//
// A single "requests relevant to me since timestamp X" query covers both things the brief asks
// this fetch mechanism to deliver: (a) a friend in the requester's group(s) learning about new
// *pending* requests (caught by `requested_at > since`), and (b) the requester learning when
// *their own* request resolves (caught by `resolved_at > since`, since resolving a request
// doesn't change requested_at). The caller (alarmHandlers.ts) distinguishes what to do with each
// row based on whether requesterUserId === the current user and what status it's in - see that
// file's pollUnlockRequestUpdates.
async function queryRelevantSince(
  sinceTimestamp: number
): Promise<{ ok: boolean; requests: UnlockRequest[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, requests: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, requests: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const sinceIso = new Date(sinceTimestamp).toISOString();
    const { data, error } = await supabase
      .from("unlock_requests")
      .select()
      .or(`requested_at.gt.${sinceIso},resolved_at.gt.${sinceIso}`)
      .order("requested_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch unlock requests", error);
      return { ok: false, requests: [] };
    }
    return { ok: true, requests: (data as UnlockRequestRow[]).map(toUnlockRequest) };
  } catch (err) {
    console.error("Failed to fetch unlock requests", err);
    return { ok: false, requests: [] };
  }
}

// On-demand fetch for UnlockRequestPanel.tsx (via messageRouter.ts's UNLOCK_REQUESTS_FETCH) -
// collapses the ok/requests distinction into a plain array, mirroring
// fetchNewEventsForFriends/fetchIncomingNudges's identical contract: a UI fetch has no persisted
// cursor to protect, so there's nothing to do differently on failure vs. "nothing new" - both
// just render as an empty/unchanged list.
export async function fetchRelevantUnlockRequests(sinceTimestamp: number): Promise<UnlockRequest[]> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.requests;
}

// Poll-specific variant for alarmHandlers.ts's friend-poll alarm - mirrors
// pollNewEventsForFriends/pollIncomingNudges's discriminated result exactly, so the alarm only
// advances its persisted "last checked for unlock requests" cursor (friendPollState.ts) on a
// confirmed successful poll, leaving it untouched on failure so the next tick retries the same
// window instead of silently and permanently dropping a pending request notification or an
// approval/denial (the exact Task 6 fix-round-1 lesson this task's brief calls out by name).
export async function pollRelevantUnlockRequests(
  sinceTimestamp: number
): Promise<{ ok: true; requests: UnlockRequest[] } | { ok: false }> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.ok ? { ok: true, requests: result.requests } : { ok: false };
}
