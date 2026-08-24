// v2 Task 13: Study Rooms - server-side LiveKit access token minting.
//
// Same structural template as generate-coaching-message/index.ts (Task 11) and
// approve-temp-passcode/index.ts (Task 12): CORS headers, json() helper, module-scoped anon/admin
// clients, Authorization-header JWT auth via anonClient.auth.getUser(jwt) rather than trusting a
// client-supplied user id.
//
// Request: { roomId: string } - called by infrastructure/backend/studyRoomApi.ts's joinRoom(),
// via supabase.functions.invoke (which automatically forwards the caller's bearer token).
//
// LIVEKIT_API_KEY/LIVEKIT_API_SECRET are Edge Function secrets only (confirmed present via
// `npx supabase secrets list --project-ref uykpyjnubzuzhgpkvjwu`, values never read or logged by
// this function beyond passing them straight into the SDK's own constructor) - same principle as
// ANTHROPIC_API_KEY in generate-coaching-message: the raw credential must never reach the client,
// so token minting has to happen here, not in studyRoomApi.ts.
//
// Authorization model (per this task's brief - "confirm they're actually a legitimate participant
// of that room ... don't trust the client's claim that they're allowed to join"): this function
// does NOT trust a client-supplied "I'm allowed" flag. It independently re-checks via
// public.is_active_room_participant(room_id, user_id) (v3.2 Task 6, supabase/migrations/
// 20260815000031_v3.2_active_room_participant.sql), called through the service-role adminClient
// (which bypasses RLS, so this read is authoritative, not itself subject to the same policies
// being tested) - the function is SECURITY DEFINER and answers the same question this file used
// to ask inline: does a study_room_participants row exist matching (room_id = roomId,
// user_id = callerId, left_at is null)? That row can only exist because studyRoomApi.ts's
// joinRoom() already inserted it as the caller's own authenticated session, which is itself gated
// by study_room_participants' INSERT policy (supabase/migrations/
// 20260815000019_v2_study_rooms_group_visibility_and_join_gate.sql - requires the caller to be
// the room's owner or share a group with the owner). So this check transitively re-derives group
// membership through the same RLS-enforced row, rather than re-implementing the group-membership
// query a second time here - if that row exists, the caller was already proven eligible at INSERT
// time by a mechanism this function does not need to re-litigate. `left_at is null` (enforced
// inside the shared function now, not this file) additionally guards against reusing a stale,
// already-left participation row to mint a fresh token later.
//
// Centralized (rather than left as this file's own inline query) so this Edge Function and
// studyRoomApi.ts's own `.is("left_at", null)` presence/listing filters can't independently drift
// out of agreement if either changes later - see V3.2_Implementation_Plan.md's Task 6/Decision 4.
// studyRoomApi.ts itself is deliberately NOT changed to call this function via RPC in this same
// task/plan (it runs as the authenticated role via RLS, not this service-role client, and a
// client-side listing query being wrong only affects what a legitimate participant sees in their
// own UI, not who can obtain a valid video token) - documented there as a follow-up, not a gap.
//
// LiveKit JS Server SDK usage confirmed against current docs (docs.livekit.io/home/server/
// generating-tokens/, v2.17.0 - the current npm version at build time) rather than guessed from
// memory: `new AccessToken(apiKey, apiSecret, { identity, ttl }).addGrant(videoGrant)` then
// `await at.toJwt()`. Imported from esm.sh with `?target=deno` (Supabase's own documented fix for
// esm.sh/Deno Edge Function import failures - docs.supabase.com/guides/troubleshooting/
// importing-stripe-or-other-modules-from-esmsh-on-deno-edge-functions-throws-an-error) since this
// package (unlike @supabase/supabase-js, already used bare elsewhere in this codebase) has not
// been proven to import cleanly on Deno without it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken, type VideoGrant } from "https://esm.sh/livekit-server-sdk@2.17.0?target=deno";

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

// How long the minted token stays valid. Not specified exactly by the plan ("short-lived access
// token scoped to that room and the caller's own identity" is the only requirement) - one hour is
// long enough to cover a realistic study-room session without needing a re-mint mid-call, short
// enough that a leaked/logged token (e.g. in browser devtools network tab) isn't a standing
// credential. Unlike unlock_requests/temp_passcode_requests' TTLs (which bound how long a security
// EXCEPTION stays open), this TTL only bounds how long this specific join credential is usable -
// leaving and rejoining the same room, or any room, simply mints a fresh one via this same
// function, gated by the same live participant-row check every time.
const TOKEN_TTL = "1h";

interface RequestBody {
  roomId?: string;
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
    if (!body.roomId) {
      return json({ error: "Missing roomId" }, 400);
    }
    const roomId = body.roomId;

    // Re-derived server-side, against the live table, via the shared is_active_room_participant
    // function (v3.2 Task 6) called through the service-role client - see header comment. Never
    // trusts anything the client asserted about its own eligibility.
    const { data: isActiveParticipant, error: participantError } = await adminClient.rpc(
      "is_active_room_participant",
      { p_room_id: roomId, p_user_id: callerId }
    );
    if (participantError) {
      console.error("Failed to verify room participant", participantError);
      return json({ error: "Server error" }, 500);
    }
    if (!isActiveParticipant) {
      return json({ error: "Not a participant of this room" }, 403);
    }

    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY");
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    if (!livekitApiKey || !livekitApiSecret) {
      console.error("LIVEKIT_API_KEY/LIVEKIT_API_SECRET are not configured");
      return json({ error: "Server misconfigured" }, 500);
    }

    // LiveKit room "name" - the plan's Interfaces line doesn't require a separate human-readable
    // room name distinct from the study_rooms.id primary key, and reusing the room's own uuid as
    // LiveKit's room name keeps the two systems' notion of "which room" trivially in sync (no
    // separate mapping table, no risk of two different study_rooms rows colliding on one LiveKit
    // room). LiveKit room names are plain strings with no format requirement beyond that.
    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: callerId,
      ttl: TOKEN_TTL,
    });
    const grant: VideoGrant = {
      room: roomId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    };
    at.addGrant(grant);
    const token = await at.toJwt();

    return json({ token }, 200);
  } catch (err) {
    console.error("generate-livekit-token crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
