import { supabase } from "./supabaseClient";
import type { TempPasscodeRequest } from "../../domain/accountability/tempPasscodeRequest";
import {
  unlockHardBlockRuleForHostname,
} from "../browser/declarativeNetRequestApi";
import { scheduleTempUnlockRelockAlarm } from "../browser/alarmsApi";

// v2 Task 12: Temporary Passcodes for Hard Mode.
//
// The exact, explicit column list every query against temp_passcode_requests in this file must
// use - deliberately excludes code_hash/code_salt (see tempPasscodeRequest.ts's header comment
// for the full rationale, and supabase/migrations/20260815000016_v2_temp_passcode_hard_mode.sql
// for the column-level GRANT that makes a bare `.select()` hard-error for these two columns
// server-side too, not just a client-side convention). requested_at/resolved_at are included
// here (needed for queryRelevantSince's `.or()`/`.order()` filter below) but deliberately NOT
// surfaced on the public TempPasscodeRequest type - see toTempPasscodeRequest.
// Deliberately a single, un-concatenated string literal (not built via `+`) - supabase-js's
// `.select(...)` overloads only pick the specific "known columns" typed overload for a genuine
// string LITERAL type; a `const` built by concatenating two literals widens to plain `string` at
// the type level, which falls back to a much less useful generic/untyped overload and breaks
// `tsc --noEmit` at every call site below (`Conversion of type 'GenericStringError' ...`).
// Mirrors sessionStatusSyncApi.ts's BASELINE_EVENT_COLUMNS, which is a single-line literal for the
// exact same reason.
const TEMP_PASSCODE_COLUMNS =
  "id, session_id, hostname, requester_user_id, friend_user_id, status, expires_at, delivered_via, failed_attempts, locked_until, requested_at, resolved_at";

interface TempPasscodeRequestRow {
  id: string;
  session_id: string;
  hostname: string;
  requester_user_id: string;
  friend_user_id: string;
  status: string;
  expires_at: string | null;
  delivered_via: string;
  failed_attempts: number;
  locked_until: string | null;
  requested_at: string;
  resolved_at: string | null;
}

function toTempPasscodeRequest(row: TempPasscodeRequestRow): TempPasscodeRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    hostname: row.hostname,
    friendUserId: row.friend_user_id,
    requesterUserId: row.requester_user_id,
    status: row.status as TempPasscodeRequest["status"],
    // Never populated with a real value - see tempPasscodeRequest.ts's header comment.
    codeHash: "",
    codeSalt: "",
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : 0,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until ? new Date(row.locked_until).getTime() : undefined,
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
export async function createRequest(
  sessionId: string,
  hostname: string,
  friendUserId: string
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

// Invokes the approve-temp-passcode Edge Function - see that function's header comment for why
// code generation/hashing must happen server-side. supabase.functions.invoke(...) automatically
// forwards the caller's bearer token, which the Edge Function uses to verify the caller IS this
// request's friend_user_id (never trusts a client-supplied claim). Returns the plaintext code
// exactly once, in this response only - it is never written anywhere.
export async function approveRequest(requestId: string): Promise<{ code: string }> {
  const { data, error } = await supabase.functions.invoke<{ code?: string; error?: string }>(
    "approve-temp-passcode",
    { body: { requestId } }
  );
  if (error || !data?.code) {
    throw new Error(data?.error ?? error?.message ?? "Failed to approve temp passcode request.");
  }
  return { code: data.code };
}

// Invokes the redeem-temp-passcode Edge Function, then - on a successful redemption - performs
// the actual unlock itself: this is the one place that knows both "redemption succeeded
// server-side" and "which hostname/expiry to act on" (per this task's brief), reading hostname/
// expiresAt straight off the Edge Function's own success response rather than a second fetch.
// Never throws (graceful degradation, matching this codebase's established
// *Api.ts convention) - a network failure, a non-2xx response, or a logical `ok: false` (wrong
// code, expired, locked, not approved) all resolve to `{ ok: false }` rather than rejecting.
export async function redeemCode(requestId: string, code: string): Promise<{ ok: boolean }> {
  try {
    const { data, error } = await supabase.functions.invoke<{
      ok?: boolean;
      hostname?: string;
      expiresAt?: number;
      error?: string;
    }>("redeem-temp-passcode", { body: { requestId, code } });

    if (error || !data?.ok) {
      return { ok: false };
    }

    // Best-effort: the server already recorded a successful redemption (failed_attempts reset,
    // etc.) by this point - a failure in the local unlock step below must not turn that genuine
    // server-side success into a reported failure (the user would see "incorrect code" for a code
    // that was, in fact, correct). Logged, not silently swallowed.
    if (data.hostname) {
      try {
        await unlockHardBlockRuleForHostname(data.hostname);
        if (data.expiresAt) {
          scheduleTempUnlockRelockAlarm(data.hostname, data.expiresAt);
        }
      } catch (err) {
        console.error("Redemption succeeded server-side, but the local unlock step failed", err);
      }
    }

    return { ok: true };
  } catch (err) {
    console.error("Failed to redeem temp passcode", err);
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
