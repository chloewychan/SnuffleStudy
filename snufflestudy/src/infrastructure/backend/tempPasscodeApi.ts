import { supabase } from "./supabaseClient";
import type { TempPasscodeRequest } from "../../domain/accountability/tempPasscodeRequest";
import {
  unlockHardBlockRuleForHostname,
} from "../browser/declarativeNetRequestApi";
import { scheduleTempUnlockRelockAlarm } from "../browser/alarmsApi";

// v2 Task 12: Temporary Passcodes for Hard Mode.
// v3.3 Task 10: the human-relayed code is gone entirely - code_hash/code_salt/failed_attempts/
// locked_until are dropped from temp_passcode_requests (migration
// 20260815000036_v3.3_temp_passcode_no_code.sql), so this column list and the row/type mapping
// below shrink to match. Approval alone is the security boundary now; there is nothing left to
// hash, salt, or lock out.
//
// The exact, explicit column list every query against temp_passcode_requests in this file must
// use. requested_at/resolved_at are included here (needed for queryRelevantSince's `.or()`/
// `.order()` filter below) but deliberately NOT surfaced on the public TempPasscodeRequest type -
// see toTempPasscodeRequest.
// Deliberately a single, un-concatenated string literal (not built via `+`) - supabase-js's
// `.select(...)` overloads only pick the specific "known columns" typed overload for a genuine
// string LITERAL type; a `const` built by concatenating two literals widens to plain `string` at
// the type level, which falls back to a much less useful generic/untyped overload and breaks
// `tsc --noEmit` at every call site below (`Conversion of type 'GenericStringError' ...`).
// Mirrors sessionStatusSyncApi.ts's BASELINE_EVENT_COLUMNS, which is a single-line literal for the
// exact same reason.
// v3.3 Task 11: `message` appended (migration 20260815000037_v3.3_temp_passcode_message.sql).
const TEMP_PASSCODE_COLUMNS =
  "id, session_id, hostname, requester_user_id, friend_user_id, status, expires_at, delivered_via, requested_at, resolved_at, message";

interface TempPasscodeRequestRow {
  id: string;
  session_id: string;
  hostname: string;
  requester_user_id: string;
  friend_user_id: string;
  status: string;
  expires_at: string | null;
  delivered_via: string;
  requested_at: string;
  resolved_at: string | null;
  message: string | null;
}

function toTempPasscodeRequest(row: TempPasscodeRequestRow): TempPasscodeRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    hostname: row.hostname,
    friendUserId: row.friend_user_id,
    requesterUserId: row.requester_user_id,
    status: row.status as TempPasscodeRequest["status"],
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : 0,
    message: row.message,
  };
}

// Mirrors sessionStatusSyncApi.ts's/nudgeApi.ts's/unlockRequestApi.ts's checkAuth() exactly (same
// ok:false-means-the-check-itself-failed vs. ok:true/userId:null-means-cleanly-signed-out
// distinction) - queryRelevantSince below is the poll-side function that needs to tell a real
// failure apart from "nothing to do" so alarmHandlers.ts's friend-poll alarm doesn't advance its
// temp-passcode cursor past a failure.
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

// createRequest/denyRequest mirror friendGroupApi.ts's/unlockRequestApi.ts's
// requireUserId()+throw convention (not nudgeApi.sendNudge's ok/error discriminated-result
// convention) - matches unlockRequestApi.createRequest's identical shape for the identical kind
// of action (an explicit, infrequent user-initiated button press, not a hot-path lifecycle
// transition), so paying getUser()'s extra round trip for a verified identity is fine here.
async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Creates a pending temp-passcode request for the given session/hostname/friend, as the current
// user. delivered_via is always 'email+in_app' (not just 'email') - per Decision 4
// (docs/V2_Implementation_Plan.md), friend_user_id is only ever a real auth.users id (drawn from
// friendGroupApi.ts's group members, by construction), so the in-app leg is "nearly free once
// Phase 2 exists" and is always genuinely available here, unlike a hypothetical email-only friend
// with no SnuffleStudy account at all.
//
// The in-app leg needs no separate write here - the row this insert creates is already visible to
// friendUserId the instant it exists, via temp_passcode_requests' pre-existing "requester or
// assigned friend can read" RLS policy (supabase/migrations/20260815000002_v2_rls_policies.sql).
// alarmHandlers.ts's friend-poll alarm (pollTempPasscodeUpdates, reusing Task 6's alarm) is what
// turns that visibility into an actual chrome.notifications toast on the friend's device - same
// pattern as unlockRequestApi.createRequest's identical comment.
//
// The email leg (send-temp-passcode-request Edge Function) is fire-and-forget - deliberately NOT
// awaited before this function resolves, per this task's brief ("don't block createRequest's
// resolution on email delivery succeeding", matching this codebase's established
// graceful-degradation posture, e.g. friendSync.ts's recordFriendStatusEvent). The row insert
// itself IS awaited, so the returned TempPasscodeRequest is always real.
//
// v3.3 Task 11: optional trailing `message` param - the requester's free-text explanation for why
// they need a pass. Omitted from the insert body entirely (not sent as `message: undefined`) when
// not provided, so a request created without one round-trips through the DB's actual NULL default
// rather than an explicit value - and so the existing "inserts a pending row" test's exact-body
// assertion keeps matching unchanged for the every-day (message-less) call.
export async function createRequest(
  sessionId: string,
  hostname: string,
  friendUserId: string,
  message?: string
): Promise<TempPasscodeRequest> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from("temp_passcode_requests")
    .insert({
      session_id: sessionId,
      hostname,
      requester_user_id: userId,
      friend_user_id: friendUserId,
      status: "pending",
      delivered_via: "email+in_app",
      ...(message ? { message } : {}),
    })
    .select(TEMP_PASSCODE_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create temp passcode request.");
  }

  const request = toTempPasscodeRequest(data as TempPasscodeRequestRow);

  supabase.functions
    .invoke("send-temp-passcode-request", { body: { requestId: request.id } })
    .catch((err) => console.error("Failed to send temp passcode request email", err));

  return request;
}

// Denies a pending request as the assigned friend. Fix round 1 (Critical, code review): this used
// to be a direct client-side table UPDATE - reasoned at the time to be safe because denying never
// touches code_hash/code_salt - but that missed that the SAME unrestricted UPDATE grant/RLS combo
// also let the REQUESTER directly rewrite status to 'approved' with a self-chosen code_hash/
// code_salt, entirely bypassing approve-temp-passcode. The fix (migration
// 20260815000017_v2_temp_passcode_lock_down_client_writes.sql) revokes ALL client UPDATE access to
// this table, full stop - so denying now goes through the narrow deny_temp_passcode_request()
// SECURITY DEFINER RPC, which permits ONLY a pending -> denied transition, only by the row's own
// friend_user_id, touching only status/resolved_at. The RPC itself raises (surfaced here as a
// thrown error) on zero rows matched - wrong id, not the assigned friend, or already resolved -
// same "first responder wins"-safety guarantee the old `.eq("status","pending")` chain gave,
// enforced server-side now instead of relying on RLS/grants alone.
export async function denyRequest(requestId: string): Promise<void> {
  await requireUserId();

  const { error } = await supabase.rpc("deny_temp_passcode_request", {
    p_request_id: requestId,
  });
  if (error) {
    throw new Error(
      error.message ?? "Could not deny this request — it may already have been resolved."
    );
  }
}

// Invokes the approve-temp-passcode Edge Function - verifies caller identity/status server-side
// (see that function's header comment). supabase.functions.invoke(...) automatically forwards the
// caller's bearer token, which the Edge Function uses to verify the caller IS this request's
// friend_user_id (never trusts a client-supplied claim). v3.3 Task 10: no code is generated or
// returned anymore - approval alone is the security boundary, so the response only carries what
// the approving friend's own UI needs to confirm the action succeeded.
export async function approveRequest(
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

// v3.3 Task 10, Decision 3: replaces redeemCode. There is no code to submit anymore - approval
// alone is the security boundary - so this performs a fresh, RLS-gated read of the request row
// itself (hostname/status/expires_at) rather than trusting anything the client already has cached
// (a stale or crafted client payload must not be able to claim access to a hostname the server
// never actually approved). temp_passcode_requests' existing "requester or assigned friend can
// read" RLS policy is what actually stops anyone but the real requester from claiming - this
// function does no additional identity check of its own, matching every other function in this
// file's "the RLS policy is the enforcement" convention.
//
// Never throws (graceful degradation, matching this codebase's established *Api.ts convention) -
// a network failure, a denied/missing row, or an already-expired window all resolve to
// `{ ok: false }` rather than rejecting.
export async function claimApproval(requestId: string): Promise<{ ok: boolean }> {
  try {
    const { data, error } = await supabase
      .from("temp_passcode_requests")
      .select("hostname, status, expires_at")
      .eq("id", requestId)
      .eq("status", "approved")
      .single();
    if (error || !data) return { ok: false };
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

// Shared implementation behind fetchRelevantTempPasscodeRequests/pollRelevantTempPasscodeRequests
// below - same split/rationale as unlockRequestApi.ts's identical queryRelevantSince: `ok`
// distinguishes "the query itself failed" from "it ran cleanly and found nothing new", which only
// matters to the poll-side caller (alarmHandlers.ts's friend-poll alarm, which must not advance
// its persisted temp-passcode cursor past a failure).
//
// Deliberately unfiltered beyond the timestamp bound - server-side RLS (supabase/migrations/
// 20260815000002_v2_rls_policies.sql, "requester or assigned friend can read temp passcode
// requests") already restricts the result to rows the caller is either the requester or the
// assigned friend of, so the client trusts whatever comes back rather than re-deriving that
// visibility logic here. Same `.or(requested_at.gt.X, resolved_at.gt.X)` shape as
// unlockRequestApi.ts's identical query, for the identical reason: covers both a friend learning
// about a NEW pending request (requested_at) and the requester learning their OWN request
// resolved (resolved_at).
async function queryRelevantSince(
  sinceTimestamp: number
): Promise<{ ok: boolean; requests: TempPasscodeRequest[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, requests: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, requests: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const sinceIso = new Date(sinceTimestamp).toISOString();
    const { data, error } = await supabase
      .from("temp_passcode_requests")
      .select(TEMP_PASSCODE_COLUMNS)
      .or(`requested_at.gt.${sinceIso},resolved_at.gt.${sinceIso}`)
      .order("requested_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch temp passcode requests", error);
      return { ok: false, requests: [] };
    }
    return { ok: true, requests: (data as TempPasscodeRequestRow[]).map(toTempPasscodeRequest) };
  } catch (err) {
    console.error("Failed to fetch temp passcode requests", err);
    return { ok: false, requests: [] };
  }
}

// On-demand fetch for LockedPage.tsx/TempPasscodePanel.tsx (via messageRouter.ts's
// TEMP_PASSCODE_REQUESTS_FETCH) - collapses the ok/requests distinction into a plain array,
// mirroring fetchRelevantUnlockRequests's identical contract.
export async function fetchRelevantTempPasscodeRequests(
  sinceTimestamp: number
): Promise<TempPasscodeRequest[]> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.requests;
}

// Poll-specific variant for alarmHandlers.ts's friend-poll alarm - mirrors
// pollRelevantUnlockRequests's discriminated result exactly, so the alarm only advances its
// persisted "last checked for temp passcode requests" cursor (friendPollState.ts) on a confirmed
// successful poll.
export async function pollRelevantTempPasscodeRequests(
  sinceTimestamp: number
): Promise<{ ok: true; requests: TempPasscodeRequest[] } | { ok: false }> {
  const result = await queryRelevantSince(sinceTimestamp);
  return result.ok ? { ok: true, requests: result.requests } : { ok: false };
}
