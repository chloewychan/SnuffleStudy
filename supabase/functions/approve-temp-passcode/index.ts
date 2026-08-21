// v2 Task 12: Temporary Passcodes for Hard Mode - the friend's "approve" action.
//
// Not explicitly named in the plan's file-structure sketch (which only names
// send-temp-passcode-request), but necessary: the plan's Interfaces line requires
// `approveRequest(requestId): Promise<{ code: string }>` to return "plaintext code returned
// exactly once... never stored". Generating and hashing the code has to happen somewhere that
// never persists plaintext anywhere - doing it server-side, with one consistent, auditable crypto
// implementation, is safer than trusting every client to correctly re-implement salted PBKDF2
// hashing. See this task's report for the full "two Edge Functions beyond the plan's literal
// sketch" note.
//
// Same structural template as generate-coaching-message/index.ts (Task 11): CORS headers, json()
// helper, module-scoped anon/admin clients, Authorization-header JWT auth via
// anonClient.auth.getUser(jwt).
//
// Request: { requestId: string } - called by the assigned friend's authenticated client
// (tempPasscodeApi.ts's approveRequest(), via supabase.functions.invoke, which automatically
// forwards the caller's bearer token - same pattern Task 11's coachingApi.ts uses).
//
// Verifies (server-side, via the service-role client - never trusts the client's own claim about
// either): the caller IS this request's friend_user_id, and the request is still 'pending'.
// Generates a short numeric code, hashes it with the exact same algorithm
// src/domain/sites/hardBlockCredential.ts uses (PBKDF2-SHA256, 100,000 iterations, random salt -
// Deno's crypto.subtle is the same Web Crypto API the browser uses, so this is a faithful
// line-for-line port, not a reinvention), and updates the row (code_hash, code_salt,
// status='approved', expires_at, resolved_at) via the service-role client. Returns the plaintext
// code in the HTTP response body ONLY - it is never written anywhere.

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

// === Salted PBKDF2 hashing - a line-for-line port of src/domain/sites/hardBlockCredential.ts's
// hashPasscode/randomSalt (renamed passcode -> code), duplicated here rather than imported across
// the src/-to-Deno-function boundary (the same "own small lookup" precedent
// generate-coaching-message/index.ts's PRESSURE_PROFILE_VOICE set for Task 11 - a Deno Edge
// Function only bundles its own function directory, not the browser extension's src/ tree, which
// depends on browser globals this Deno runtime doesn't have anyway). redeem-temp-passcode/index.ts
// duplicates this exact same block - if hardBlockCredential.ts's algorithm ever changes, both
// need a matching update; there is no automated sync between the three.
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

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toHex(bytes.buffer);
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

// A short numeric code (v1's own passcode convention has no fixed format -
// hardBlockCredential.test.ts exercises plain digit strings like "1234" - but a 6-digit code is
// the most natural fit for something a friend reads aloud/types into a chat message, mirroring
// common OTP conventions). Rejection sampling (not a plain `byte % 10`) avoids modulo bias: 256
// isn't evenly divisible by 10, so a naive `byte % 10` would very slightly favor digits 0-5 over
// 6-9 - discarding bytes >= 250 (the largest multiple of 10 <= 256) removes that bias entirely.
const CODE_LENGTH = 6;

function randomDigit(): number {
  const REJECTION_CEILING = 250;
  let byte: number;
  do {
    byte = crypto.getRandomValues(new Uint8Array(1))[0]!;
  } while (byte >= REJECTION_CEILING);
  return byte % 10;
}

function generateNumericCode(length: number): string {
  return Array.from({ length }, () => randomDigit()).join("");
}

// How long an approved code stays valid - the plan doesn't specify an exact duration ("time-boxed"
// is the only requirement). 15 minutes is long enough for the friend to actually communicate the
// code out-of-band (a text message, a shouted word through a wall) and the requester to type it
// in, short enough that "temporary" means something concrete rather than an all-session unlock
// (which is what unlock_requests/Task 8 already covers for a longer-lived grant).
const TTL_MS = 15 * 60 * 1000;

interface RequestBody {
  requestId?: string;
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
    if (!body.requestId) {
      return json({ error: "Missing requestId" }, 400);
    }

    const { data: row, error: rowError } = await adminClient
      .from("temp_passcode_requests")
      .select("id, hostname, friend_user_id, status")
      .eq("id", body.requestId)
      .single();
    if (rowError || !row) {
      return json({ error: "Request not found" }, 404);
    }
    if (row.friend_user_id !== callerId) {
      return json({ error: "Not authorized to approve this request" }, 403);
    }
    if (row.status !== "pending") {
      return json({ error: `Request is already ${row.status}, not pending` }, 409);
    }

    const code = generateNumericCode(CODE_LENGTH);
    const codeSalt = randomSalt();
    const codeHash = await hashCode(code, codeSalt);
    const now = Date.now();
    const expiresAt = now + TTL_MS;

    const { error: updateError } = await adminClient
      .from("temp_passcode_requests")
      .update({
        code_hash: codeHash,
        code_salt: codeSalt,
        status: "approved",
        expires_at: new Date(expiresAt).toISOString(),
        resolved_at: new Date(now).toISOString(),
        failed_attempts: 0,
        locked_until: null,
      })
      .eq("id", row.id)
      .eq("status", "pending"); // First-responder-wins guard, mirrors unlock_requests' pattern.
    if (updateError) {
      console.error("Failed to persist approved temp passcode", updateError);
      return json({ error: "Failed to approve request" }, 500);
    }

    // The plaintext code appears here, in this response body, exactly once - it is never written
    // to any table, log line, or other response.
    return json({ code, hostname: row.hostname, expiresAt }, 200);
  } catch (err) {
    console.error("approve-temp-passcode crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
