// v3.2 Task 8: Account/data deletion.
//
// Same structural template as generate-coaching-message/index.ts, approve-temp-passcode/
// index.ts, and generate-livekit-token/index.ts: CORS headers, json() helper, module-scoped
// anon/admin clients, Authorization-header JWT auth via anonClient.auth.getUser(jwt) rather than
// trusting a client-supplied user id.
//
// Request: no body at all (deliberately - see below). Called by
// infrastructure/backend/accountApi.ts's deleteAccount(), via supabase.functions.invoke (which
// automatically forwards the caller's bearer token).
//
// Self-service guarantee ("callable only by the authenticated user themselves ... never a
// service-role-only operation triggered by someone else", per the plan's own Interfaces line):
// this function takes NO userId/target field in its request body - the only identity it ever
// acts on is `callerId`, resolved exclusively from the caller's own verified JWT. There is
// structurally no code path here that can act on any id other than the caller's own, unlike (say)
// a function that accepted `{ userId }` and merely checked it matched the caller - that shape
// would still be self-service-only in practice, but this shape can't even be misused if a future
// edit forgot the check, because there is no parameter to check.
//
// Why this needs to be an Edge Function rather than a plain client-callable RPC (the plan offers
// either): two of this operation's three real components need privileges/APIs a Postgres function
// cannot reach on its own -
//   1. Producer Tag audio Storage cleanup needs the Storage HTTP API (adminClient.storage.from(
//      bucket).remove(paths)) - deleting storage.objects rows directly via SQL only removes
//      metadata, not the backing bytes in the S3-compatible store behind Supabase Storage. See
//      supabase/migrations/20260815000032_v3.2_account_deletion.sql's header comment for the full
//      reasoning.
//   2. Actually removing the auth.users row needs the Auth Admin API (adminClient.auth.admin.
//      deleteUser) - this is Supabase's own documented, supported mechanism for deleting a user
//      (it also correctly tears down auth.identities/auth.sessions/auth.refresh_tokens/mfa
//      factors, none of which this codebase's own migrations own or could safely hand-delete via
//      raw SQL against Supabase's internal auth schema).
// The actual per-table row deletion (every table in this schema referencing the caller's
// auth.uid()) is delegated to public.delete_account_data(p_user_id) (same migration as above) -
// a service_role-only SQL function, called from here via adminClient.rpc(...), matching this
// codebase's existing convention (adminClient.rpc("is_active_room_participant", ...) in
// generate-livekit-token, adminClient.rpc("check_and_record_coaching_message_request", ...) in
// generate-coaching-message).
//
// Order of operations, and why: (1) row deletion first - it's the least reversible-feeling part
// to leave half-done, and if it fails, nothing else has happened yet, so the failure is atomic
// from the caller's point of view (a single { error } response, no partial cleanup visible
// anywhere). (2) Storage object removal next, using the audio_url list delete_account_data just
// returned. (3) auth.users deletion LAST, deliberately - if Storage's own metadata table
// (storage.objects) has any FK or trigger dependency on auth.users that this codebase doesn't
// control, removing the actual objects first (step 2) is what clears it, so step 3 has the best
// chance of succeeding cleanly. A failure in step 2 is logged but does not block step 3 from being
// attempted (the app-schema data is already fully gone after step 1 either way, which is this
// function's main DoD-required guarantee) - a lingering orphaned Storage object with no
// producer_tags row pointing at it is a cleanup nuisance, not a data-exposure risk, since nothing
// in this codebase can look it up without that row.
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

const PRODUCER_TAGS_BUCKET = "producer-tags";

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

    // Step 1: every app-schema row referencing this user, across every table in this schema that
    // has one (see the migration's header comment for the full, verified-against-the-live-schema
    // table list). Returns the Producer Tag audio_url paths that were just deleted from
    // producer_tags, so step 2 knows what to remove from Storage.
    const { data: audioUrls, error: dataError } = await adminClient.rpc("delete_account_data", {
      p_user_id: callerId,
    });
    if (dataError) {
      console.error("Failed to delete account data", dataError);
      return json({ error: "Server error" }, 500);
    }

    // Step 2: Storage cleanup. Best-effort relative to step 3 (see header comment) - a failure
    // here is logged, not fatal, since the app-schema data (this function's main DoD guarantee)
    // is already gone after step 1.
    const paths = (audioUrls as string[] | null) ?? [];
    if (paths.length > 0) {
      const { error: storageError } = await adminClient.storage
        .from(PRODUCER_TAGS_BUCKET)
        .remove(paths);
      if (storageError) {
        console.error("Failed to remove Producer Tag audio from Storage", storageError);
      }
    }

    // Step 3: the auth.users row itself, via Supabase's own supported Admin API (not raw SQL -
    // see header comment for why).
    const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(callerId);
    if (deleteUserError) {
      console.error("Failed to delete auth.users row", deleteUserError);
      return json({ error: "Server error" }, 500);
    }

    return json({ ok: true }, 200);
  } catch (err) {
    console.error("delete-account crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
