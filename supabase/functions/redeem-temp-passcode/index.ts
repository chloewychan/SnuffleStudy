// v2 Task 12: Temporary Passcodes for Hard Mode - the requester's "redeem" action.
//
// Not explicitly named in the plan's file-structure sketch either (same reasoning as
// approve-temp-passcode/index.ts's header comment) - verification must never expose code_hash to
// any client, so the comparison has to happen server-side, in the one place that legitimately
// reads it (the service-role client).
//
// Same structural template as generate-coaching-message/index.ts (Task 11).
//
// Request: { requestId: string, code: string }. Requires authentication (Authorization header
// JWT) and verifies the caller IS this request's requester_user_id - defense-in-depth beyond what
// the plan's literal spec requires: the requester's browser is already signed in by the time this
// screen is reachable (createRequest itself required requireUserId()), so this costs nothing
// legitimate and closes off redemption-guessing by an arbitrary authenticated third party who
// merely learned/guessed a requestId.
//
// Order of checks (mirrors this task's brief exactly): status === 'approved' -> expires_at still
// in the future (an expired-but-still-'approved' row is treated as expired, and its status is
// flipped to 'expired' as a side effect - see the comment at that check below) -> locked_until (if
// set and in the future, reject WITHOUT even hashing/comparing the candidate code - mirrors
// src/domain/sites/hardBlockCredential.ts's verifyPasscode's lockout-check-first behavior) -> hash
// the candidate with the stored code_salt and compare to code_hash.
//
// On success: failed_attempts resets to 0, response includes hostname/expiresAt (not secret) so
// tempPasscodeApi.ts's redeemCode can perform the actual unlock (unlockHardBlockRuleForHostname +
// scheduleTempUnlockRelockAlarm) without a second round trip to re-fetch the row.
// On failure: failed_attempts increments; crossing MAX_ATTEMPTS_BEFORE_LOCKOUT sets locked_until -
// reusing hardBlockCredential.ts's EXACT constants (3 attempts, 60-second lockout) for parity, per
// this task's brief: "a temp code is not allowed to be a weaker link than the permanent one".
//
// code_hash/code_salt are never included in ANY response body, on any path.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anonClient =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// === Salted PBKDF2 hashing - duplicated verbatim from approve-temp-passcode/index.ts (itself a
// line-for-line port of src/domain/sites/hardBlockCredential.ts's hashPasscode). See that file's
// identical comment for why this is a deliberate small duplication, not a missed shared-module
// opportunity.
const PBKDF2_ITERATIONS = 100_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

async function hashCode(code: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const codeBytes = encoder.encode(code);
  const saltBytes = hexToBytes(salt);

  const key = await crypto.subtle.importKey("raw", codeBytes, "PBKDF2", false, ["deriveBits"]);

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256
  );

  return toHex(derivedBits);
}

// Reused verbatim from src/domain/sites/hardBlockCredential.ts - "a temp code is not allowed to
// be a weaker link than the permanent one" (this task's brief).
const MAX_ATTEMPTS_BEFORE_LOCKOUT = 3;
const LOCKOUT_DURATION_MS = 60_000;

interface RequestBody {
  requestId?: string;
  code?: string;
}

interface TempPasscodeRow {
  id: string;
  hostname: string;
  requester_user_id: string;
  status: string;
  code_hash: string | null;
  code_salt: string | null;
  expires_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    if (!anonClient || !adminClient) {
      console.error("Missing Supabase environment configuration");
      return json({ error: "Server misconfigured" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Not authenticated" }, 401);
    }
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not authenticated" }, 401);
    }
    const callerId = userData.user.id;

    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.requestId || !body.code) {
      return json({ error: "Missing requestId or code" }, 400);
    }

    const { data: rowData, error: rowError } = await adminClient
      .from("temp_passcode_requests")
      .select(
        "id, hostname, requester_user_id, status, code_hash, code_salt, expires_at, failed_attempts, locked_until"
      )
      .eq("id", body.requestId)
      .single();
    if (rowError || !rowData) {
      return json({ error: "Request not found" }, 404);
    }
    const row = rowData as TempPasscodeRow;

    if (row.requester_user_id !== callerId) {
      return json({ error: "Not authorized to redeem this request" }, 403);
    }

    if (row.status !== "approved") {
      return json({ ok: false, error: `Request is ${row.status}, not approved` }, 200);
    }

    const now = Date.now();

    // An expired-but-still-'approved'-status row is treated as expired, not valid - and flipped
    // to status='expired' here as a side effect, so any subsequent read (e.g. the requester's own
    // poll-driven notification, or a second redeem attempt) sees accurate state rather than a
    // stale 'approved' label that's actually unusable. Best-effort: if this update itself fails,
    // the redemption is still correctly rejected below (the in-memory `row.status` check on the
    // NEXT request would just redo this same flip) - it's a cleanup side effect, not the security
    // boundary itself (expires_at > now is what's actually enforced).
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) {
      const { error: expireError } = await adminClient
        .from("temp_passcode_requests")
        .update({ status: "expired", resolved_at: new Date(now).toISOString() })
        .eq("id", row.id)
        .eq("status", "approved");
      if (expireError) {
        console.error("Failed to flip expired temp passcode request's status", expireError);
      }
      return json({ ok: false, error: "This code has expired" }, 200);
    }

    // Lockout check BEFORE hashing/comparing the candidate code at all - mirrors
    // hardBlockCredential.ts's verifyPasscode, which checks lockedUntil first for the identical
    // reason (no point spending a PBKDF2 derivation, or leaking any timing signal from it, on a
    // guess that's rejected regardless of correctness).
    if (row.locked_until && new Date(row.locked_until).getTime() > now) {
      return json({ ok: false, error: "Too many attempts - temporarily locked" }, 200);
    }

    if (!row.code_hash || !row.code_salt) {
      // Shouldn't be reachable (status='approved' is only ever set alongside both, in
      // approve-temp-passcode) - defensive guard against a malformed row rather than crashing.
      console.error("Approved temp passcode request is missing code_hash/code_salt", row.id);
      return json({ ok: false, error: "Request is not redeemable" }, 200);
    }

    const candidateHash = await hashCode(body.code, row.code_salt);
    const success = candidateHash === row.code_hash;

    if (success) {
      const { error: successError } = await adminClient
        .from("temp_passcode_requests")
        .update({ failed_attempts: 0, locked_until: null })
        .eq("id", row.id);
      if (successError) {
        console.error("Failed to reset failed_attempts after a successful redeem", successError);
      }
      // hostname/expiresAt are not secret - returned so the client can perform the actual unlock
      // (unlockHardBlockRuleForHostname + scheduleTempUnlockRelockAlarm) without a second fetch.
      return json(
        { ok: true, hostname: row.hostname, expiresAt: new Date(row.expires_at!).getTime() },
        200
      );
    }

    const failedAttempts = row.failed_attempts + 1;
    const lockedUntil =
      failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCKOUT
        ? new Date(now + LOCKOUT_DURATION_MS).toISOString()
        : null;
    const { error: failError } = await adminClient
      .from("temp_passcode_requests")
      .update({ failed_attempts: failedAttempts, locked_until: lockedUntil })
      .eq("id", row.id);
    if (failError) {
      console.error("Failed to record a failed temp passcode redeem attempt", failError);
    }

    return json({ ok: false, error: "Incorrect code" }, 200);
  } catch (err) {
    console.error("redeem-temp-passcode crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
