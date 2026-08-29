import { supabase } from "./supabaseClient";
import { requireUserId, checkAuth } from "./authHelpers";
import type { FriendRequest, FriendRequestKind } from "../../domain/accountability/friendRequest";
import { unlockHardBlockRuleForHostname } from "../browser/declarativeNetRequestApi";
import { scheduleTempUnlockRelockAlarm } from "../browser/alarmsApi";

// v3.4 Task 3: replaces unlockRequestApi.ts/tempPasscodeApi.ts/sessionEndRequestApi.ts (all three
// deleted outright) - one file, parameterized by `kind`, backing friend_requests
// (supabase/migrations/20260815000041_v3.4_friend_requests.sql). Imports requireUserId/checkAuth
// from authHelpers.ts (Task 1) from the start, rather than gaining a fresh local copy the way the
// three files it replaces each independently defined one.
const COLUMNS =
  "id, kind, requester_user_id, friend_user_id, message, status, requested_at, resolved_at, resolved_by, hostname, session_id, expires_at";

interface FriendRequestRow {
  id: string;
  kind: FriendRequestKind;
  requester_user_id: string;
  friend_user_id: string | null;
  message: string | null;
  status: FriendRequest["status"];
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  hostname: string | null;
  session_id: string;
  expires_at: string | null;
}

function toFriendRequest(row: FriendRequestRow): FriendRequest {
  return {
    id: row.id,
    kind: row.kind,
    requesterUserId: row.requester_user_id,
    friendUserId: row.friend_user_id,
    message: row.message,
    status: row.status,
    requestedAt: new Date(row.requested_at).getTime(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null,
    resolvedBy: row.resolved_by,
    hostname: row.hostname,
    sessionId: row.session_id,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
  };
}

// One creation function for all three kinds, parameterized by kind + a context object holding
// exactly the fields that kind needs - mirrors LockedPage.tsx's/EndSessionControl.tsx's/
// RequestUnlockForm.tsx's shared call shape (Decision 5 / scope doc's "all three now call the
// same shared createRequest"). message is omitted from the insert body entirely (not sent as
// `message: undefined`) when not provided - same convention tempPasscodeApi.ts's createRequest
// already established, so a request created without one round-trips through the DB's actual NULL
// default rather than an explicit value.
export async function createRequest(
  kind: FriendRequestKind,
  context: { sessionId: string; friendUserId?: string; message?: string; hostname?: string }
): Promise<FriendRequest> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("friend_requests")
    .insert({
      kind,
      session_id: context.sessionId,
      requester_user_id: userId,
      friend_user_id: context.friendUserId ?? null,
      hostname: context.hostname ?? null,
      status: "pending",
      ...(context.message ? { message: context.message } : {}),
    })
    .select(COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create that request.");
  }
  return toFriendRequest(data as FriendRequestRow);
}

// Plain client UPDATE - valid for: denying ANY kind, or approving site_unlock/session_end.
// Approving a site_temp_pass request must go through approveTempPass() below instead - RLS's
// WITH CHECK clause enforces this server-side regardless of what this function is called with
// (see the migration's own comment, and this task's own security-critical negative-case test), so
// this is a client-side guard for a clear error message, not the actual security boundary.
//
// Deliberately chains .select().single() after the update, for the same "first responder wins"
// reason unlockRequestApi.ts's/sessionEndRequestApi.ts's identical resolveRequest documented at
// length: an UPDATE matching zero rows is not itself a Postgres/PostgREST error, which is exactly
// what happens when a second friend attempts to resolve a request another friend already resolved
// a moment earlier. Without forcing a `.single()` read of the (now zero) affected rows, this
// function would resolve successfully with no error and no data.
export async function resolveRequest(
  requestId: string,
  decision: "approved" | "denied"
): Promise<void> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("friend_requests")
    .update({ status: decision, resolved_at: new Date().toISOString(), resolved_by: userId })
    .eq("id", requestId)
    .select()
    .single();
  if (error || !data) {
    throw new Error(
      error?.message ??
        "Could not resolve this request — it may already have been resolved, or (if approving a temporary pass) needs Approve, not this path."
    );
  }
}

// site_temp_pass approval only - Edge Function invoke, unchanged behavior from
// tempPasscodeApi.ts's current approveRequest().
export async function approveTempPass(
  requestId: string
): Promise<{ hostname: string; expiresAt: number }> {
  const { data, error } = await supabase.functions.invoke<{
    hostname?: string;
    expiresAt?: number;
    error?: string;
  }>("approve-temp-passcode", { body: { requestId } });
  if (error || !data?.hostname || typeof data.expiresAt !== "number") {
    throw new Error(data?.error ?? error?.message ?? "Failed to approve temp passcode request.");
  }
  return { hostname: data.hostname, expiresAt: data.expiresAt };
}

// site_temp_pass only - unchanged behavior from tempPasscodeApi.ts's current claimApproval(): a
// fresh, RLS-gated read of the request row itself rather than trusting anything the client
// already has cached, then performs the actual local unlock. Never throws (graceful degradation,
// matching this codebase's established *Api.ts convention) - a network failure, a denied/missing
// row, or an already-expired window all resolve to `{ ok: false }` rather than rejecting.
export async function claimApproval(requestId: string): Promise<{ ok: boolean }> {
  try {
    const { data, error } = await supabase
      .from("friend_requests")
      .select("hostname, status, expires_at")
      .eq("id", requestId)
      .eq("kind", "site_temp_pass")
      .eq("status", "approved")
      .single();
    if (error || !data || !data.hostname) return { ok: false };
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return { ok: false };
    await unlockHardBlockRuleForHostname(data.hostname);
    if (data.expires_at) {
      scheduleTempUnlockRelockAlarm(data.hostname, new Date(data.expires_at).getTime());
    }
    return { ok: true };
  } catch (err) {
    console.error("Failed to claim an approved temp passcode request", err);
    return { ok: false };
  }
}

// SECURITY-CRITICAL - generalizes sessionEndRequestApi.ts's isApprovedForSelf exactly (see that
// function's own comment, reproduced here, for the full reasoning this preserves verbatim): does
// its own fresh read, never trusts a client-supplied status, and explicitly compares
// requester_user_id against the CALLER's own freshly-verified identity - RLS's
// "friend_user_id = auth.uid()" SELECT branch deliberately lets the resolving friend read this
// row too, which is not the same thing as it being THEIR pass to use. Kind-scoped (only ever
// called for "session_end" today, but takes kind as a param rather than hardcoding it, in case a
// future kind needs the same guard).
export async function isApprovedForSelf(
  requestId: string,
  kind: FriendRequestKind,
  sessionId: string
): Promise<boolean> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("friend_requests")
    .select("kind, session_id, status, requester_user_id")
    .eq("id", requestId)
    .single();
  if (error || !data) return false;
  return (
    data.kind === kind &&
    data.status === "approved" &&
    data.session_id === sessionId &&
    data.requester_user_id === userId
  );
}

// Shared implementation behind fetchRelevantRequests/pollRelevantRequests below - same
// split/rationale as unlockRequestApi.ts's/tempPasscodeApi.ts's/sessionEndRequestApi.ts's
// identical queryRelevantSince: `ok` distinguishes "the query itself failed" from "it ran cleanly
// and found nothing new", which only matters to the poll-side caller (alarmHandlers.ts's
// friend-poll alarm, which must not advance its persisted friend-request cursor past a failure).
//
// Deliberately unfiltered beyond the timestamp bound - server-side RLS (this migration's own
// SELECT policy) already restricts the result to: the caller's own requests (any status),
// requests assigned to the caller (any status), and pending requests from anyone the caller is
// friends with, when friend_user_id is null. The client trusts whatever comes back rather than
// re-deriving that visibility logic here.
async function queryRelevantSince(
  sinceTimestamp: number
): Promise<{ ok: boolean; requests: FriendRequest[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, requests: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, requests: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const sinceIso = new Date(sinceTimestamp).toISOString();
    const { data, error } = await supabase
      .from("friend_requests")
      .select(COLUMNS)
      .or(`requested_at.gt.${sinceIso},resolved_at.gt.${sinceIso}`)
      .order("requested_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch friend requests", error);
      return { ok: false, requests: [] };
    }
    return { ok: true, requests: (data as FriendRequestRow[]).map(toFriendRequest) };
  } catch (err) {
    console.error("Failed to fetch friend requests", err);
    return { ok: false, requests: [] };
  }
}

// On-demand fetch for useIncomingActivity.ts (v4.1 Task 8)/RequestUnlockForm.tsx/LockedPage.tsx/
// EndSessionControl.tsx (via messageRouter.ts's FRIEND_REQUESTS_FETCH) - collapses the
// ok/requests distinction into a plain array, mirroring every prior fetchRelevant*'s identical
// contract.
export async function fetchRelevantRequests(sinceTimestamp: number): Promise<FriendRequest[]> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.requests;
}

// Poll-specific variant for alarmHandlers.ts's friend-poll alarm - mirrors every prior
// pollRelevant*'s discriminated result exactly, so the alarm only advances its persisted "last
// checked for friend requests" cursor (friendPollState.ts) on a confirmed successful poll.
export async function pollRelevantRequests(
  sinceTimestamp: number
): Promise<{ ok: true; requests: FriendRequest[] } | { ok: false }> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.ok ? { ok: true, requests: result.requests } : { ok: false };
}
