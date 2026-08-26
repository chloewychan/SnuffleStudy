// v3.3 Task 10: Temp-passcode redesign - the friend's "approve" action, with the code entirely
// removed. Approval alone is, and always was, the actual security boundary: this function already
// verified the caller IS this request's friend_user_id and that the request is still 'pending'
// before generating a code - that check is unchanged. What's gone is everything downstream of it
// (PBKDF2 hashing, salt generation, the plaintext code itself) - there is nothing left to relay
// out-of-band, so the response carries only what the requester's client needs to know the request
// is now approved: hostname and expiresAt.
//
// v3.4 Task 3: temp_passcode_requests -> friend_requests (kind = 'site_temp_pass'). Only the
// queried/updated table and the added kind filter change - the JWT auth check, the
// caller-must-be-the-assigned-friend check, the pending-status check, and the TTL_MS=15min
// generation are all byte-identical to the pre-v3.4 version. This is the ONE friend_requests
// mutation that does NOT go through the shared plain-client resolveRequest() path (Decision 3,
// docs/implementation_plans/V3.4_Implementation_Plan.md) - friend_requests' UPDATE policy's WITH
// CHECK clause explicitly excludes a plain client from setting status='approved' when
// kind='site_temp_pass', so this service-role Edge Function remains the only way that transition
// can happen at all.
//
// Same structural template as generate-coaching-message/index.ts: CORS headers, json() helper,
// module-scoped anon/admin clients, Authorization-header JWT auth via anonClient.auth.getUser(jwt).
//
// Request: { requestId: string } - called by the assigned friend's authenticated client
// (tempPasscodeApi.ts's approveRequest(), via supabase.functions.invoke, which automatically
// forwards the caller's bearer token).
//
// Verifies (server-side, via the service-role client - never trusts the client's own claim about
// either): the caller IS this request's friend_user_id, and the request is still 'pending'. Then
// sets status='approved'/expires_at/resolved_at via the service-role client. Returns
// { hostname, expiresAt } - no code field.

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

// How long an approved request stays valid - the plan doesn't specify an exact duration
// ("time-boxed" is the only requirement), unchanged from the pre-redesign value. 15 minutes is
// long enough for the requester to notice the approval (a background poll tick, or clicking
// "Check status") and get unlocked, short enough that "temporary" means something concrete rather
// than an all-session unlock (which is what unlock_requests already covers for a longer-lived
// grant).
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
      .from("friend_requests")
      .select("id, hostname, friend_user_id, status")
      .eq("id", body.requestId)
      .eq("kind", "site_temp_pass")
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

    const now = Date.now();
    const expiresAt = now + TTL_MS;

    const { error: updateError } = await adminClient
      .from("friend_requests")
      .update({
        status: "approved",
        expires_at: new Date(expiresAt).toISOString(),
        resolved_at: new Date(now).toISOString(),
      })
      .eq("id", row.id)
      .eq("kind", "site_temp_pass")
      .eq("status", "pending"); // First-responder-wins guard, mirrors unlock_requests' pattern.
    if (updateError) {
      console.error("Failed to persist approved temp passcode request", updateError);
      return json({ error: "Failed to approve request" }, 500);
    }

    return json({ hostname: row.hostname, expiresAt }, 200);
  } catch (err) {
    console.error("approve-temp-passcode crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
