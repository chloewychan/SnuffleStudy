// v2 Task 11: Dynamic Coach Coaching Messages.
//
// Deno Edge Function - the first one this codebase deploys. Request shape mirrors
// infrastructure/backend/coachingApi.ts's generateCoachingMessage() exactly (see that file):
//   { pressureProfileId: string; goal: string; hostname: string; interventionLevel: InterventionLevel }
// Response is `{ message: string }` on success, `{ error: string }` (non-2xx) on every failure
// path - coachingApi.ts treats ANY non-2xx (rate-limited, unauthenticated, upstream model error,
// server misconfiguration) as a trigger to fall back to v1's static pickWarningMessage() pool, so
// this function never needs to distinguish failure kinds for the client - only for its own logs.
//
// Reads ANTHROPIC_API_KEY via Deno.env.get(...) only - never logged, never echoed in a response.
// Uses SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY, all auto-injected into every
// Edge Function's environment by Supabase - none of these three need to be set manually.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Rate limit: 12 requests per rolling 60-second window, per user. Chosen at the lower end of the
// brief's suggested 10-20/min range - SnufflesOverlay calls generateCoachingMessage() once per
// BLOCKED-site mount (content/index.ts / overlayHost.tsx), so even a user rapidly bouncing across
// several restricted tabs within a minute realistically produces a handful of calls, not dozens.
// 12/min leaves comfortable headroom for that legitimate burst while still bounding the worst
// case (a stuck/looping content script re-mounting continuously) to a fixed ~720 Claude calls per
// user per hour if pinned at the ceiling the whole time - a real but bounded cost, not unbounded.
const RATE_LIMIT_MAX_REQUESTS = 12;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Small, static lookup of each PressureProfile's voice - duplicated intentionally from
// src/domain/pressure/pressureProfiles.ts (name/intensity/description only, never the message
// pools themselves, which stay client-side as coachingApi.ts's fallback). A Deno Edge Function
// deploys only this directory's own files (`supabase functions deploy` bundles per-function), so
// importing app source across that boundary isn't an option - this is the "own small lookup" the
// task brief anticipated. If PRESSURE_PROFILES in that file ever changes, this table needs a
// matching update - there is no automated sync between them.
const PRESSURE_PROFILE_VOICE: Record<
  string,
  { name: string; intensity: string; description: string }
> = {
  "gentle-encouragement": {
    name: "Gentle Encouragement",
    intensity: "gentle",
    description: "Warm, supportive nudges. No judgment.",
  },
  "strict-coach": {
    name: "Strict Coach",
    intensity: "moderate",
    description: "Firm, direct, no-nonsense accountability.",
  },
  "ruthless-roaster": {
    name: "Ruthless Roaster",
    intensity: "ruthless",
    description: "Theatrically merciless. Loud, funny, relentless.",
  },
  "parent-mode": {
    name: "Parent Mode",
    intensity: "moderate",
    description: "Caring but exasperated. Classic parent energy.",
  },
  "hype-squad": {
    name: "Hype Squad",
    intensity: "moderate",
    description: "Loud, energetic, relentlessly positive.",
  },
  "silent-enforcement": {
    name: "Silent Enforcement",
    intensity: "ruthless",
    description: "No commentary. Just strict, quiet enforcement.",
  },
};

interface CoachingMessageRequestBody {
  pressureProfileId?: string;
  goal?: string;
  hostname?: string;
  interventionLevel?: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// Fix round 1 (latency): hoisted to module scope so a warm Deno isolate reuses the same client
// (and whatever HTTP connection pooling supabase-js/Deno's fetch does underneath it) across
// invocations, instead of constructing a fresh client object on every single request. Neither
// client depends on request-specific state - the anon client is always the same
// project URL + anon key, and the service-role client is only ever used for the rate-limit RPC.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anonClient =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const startedAt = Date.now();

  try {
    if (!anonClient || !adminClient) {
      console.error("Missing Supabase environment configuration");
      return json({ error: "Server misconfigured" }, 500);
    }

    // Identify the caller. supabase.functions.invoke(...) on the client (coachingApi.ts)
    // automatically forwards the caller's bearer token in the Authorization header - verified
    // here via the anon-key client's auth.getUser(jwt), per this task's brief, rather than
    // trusting a client-supplied user id in the request body.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Not authenticated" }, 401);
    }
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not authenticated" }, 401);
    }
    const userId = userData.user.id;

    let body: CoachingMessageRequestBody;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const { pressureProfileId, goal, hostname, interventionLevel } = body;
    if (!pressureProfileId || !goal || !hostname || !interventionLevel) {
      return json({ error: "Missing required fields" }, 400);
    }

    // Fix round 1 (latency + atomicity): a single RPC replaces the old two-step SELECT count(...)
    // then INSERT (two separate round trips to Postgres). See
    // supabase/migrations/20260815000015_v2_coaching_message_atomic_rate_limit.sql for the
    // function body - it does the count check and the insert inside one PL/pgSQL function call,
    // serialized per-user via pg_advisory_xact_lock so two concurrent requests from the same user
    // can no longer both read a below-limit count before either has inserted its own row (the
    // race the old two-step version had). coaching_message_requests has no RLS policies at all
    // (20260815000014), so only this service-role client can call it.
    const { data: admitted, error: rpcError } = await adminClient.rpc(
      "check_and_record_coaching_message_request",
      {
        p_user_id: userId,
        p_max_requests: RATE_LIMIT_MAX_REQUESTS,
        p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      }
    );
    if (rpcError) {
      console.error("Rate limit check failed", rpcError);
      return json({ error: "Server error" }, 500);
    }
    if (!admitted) {
      return json({ error: "Rate limited" }, 429);
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      console.error("ANTHROPIC_API_KEY is not configured");
      return json({ error: "Server misconfigured" }, 500);
    }

    const profile = PRESSURE_PROFILE_VOICE[pressureProfileId] ?? {
      name: "Coach",
      intensity: "moderate",
      description: "A direct, encouraging accountability coach.",
    };

    const escalationNote =
      interventionLevel === "escalated"
        ? "This is a REPEATED distraction in this same study session - the user was already warned once."
        : "This is the user's FIRST distraction warning in this study session.";

    const systemPrompt =
      `You are Snuffles, a study-accountability companion with a "${profile.name}" personality: ` +
      `${profile.description} Voice intensity: ${profile.intensity}. ` +
      "Write exactly ONE short sentence (under 20 words) calling the user back to their specific " +
      "study goal, written in that voice. Engage with the actual goal text naturally rather than " +
      "just repeating it verbatim. Output ONLY the single line - no quotation marks, no markdown, " +
      "no XML or internal tags, no preamble, no explanation.";

    const userPrompt =
      `Goal: "${goal}"\n` +
      `They just got distracted on: ${hostname}\n` +
      escalationNote;

    // Raw fetch to the Messages API (no Anthropic SDK dependency in this Deno function). Model
    // choice: claude-haiku-4-5 - fastest/cheapest current Anthropic model, the correct fit for
    // this specific constraint (fix round 1): coachingApi.ts races this whole round trip against
    // an 800ms client-side timeout, on every single distraction event, to generate one short
    // sentence with no tool use, no long context, and no complex reasoning - not a task where
    // Opus-tier's baseline latency or separate (tighter) rate-limit pool make sense. Haiku 4.5
    // doesn't support `thinking`/`output_config.effort` the way Opus/Sonnet 5 do (effort errors
    // on this model), so neither field is sent - omitting `thinking` entirely already means "no
    // thinking" on this model, which is what a single short sentence needs anyway.
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text().catch(() => "");
      console.error(`Anthropic API error ${claudeResponse.status}: ${errText}`);
      return json({ error: "Upstream model error" }, 502);
    }

    const claudeData = await claudeResponse.json();

    // A safety-classifier decline (any current Claude model can return stop_reason: "refusal"
    // with a 200 and possibly empty content) - treat that as a failure the client should fall
    // back on, not as a successful-but-empty message.
    if (claudeData.stop_reason === "refusal") {
      console.error("Model declined to respond", claudeData.stop_details ?? null);
      return json({ error: "Model declined to respond" }, 502);
    }

    const textBlock = Array.isArray(claudeData.content)
      ? claudeData.content.find((block: { type?: string }) => block?.type === "text")
      : undefined;
    const message: string | undefined = textBlock?.text?.trim();

    if (!message) {
      console.error("No text content in Claude response", JSON.stringify(claudeData).slice(0, 500));
      return json({ error: "No message generated" }, 502);
    }

    // Total elapsed time, server-side, logged (not returned to the client) - the only
    // observability this function has without a dedicated logs-viewing CLI command in this
    // environment; harmless (no request content, no secrets).
    console.log(`generate-coaching-message ok in ${Date.now() - startedAt}ms`);
    return json({ message }, 200);
  } catch (err) {
    console.error("generate-coaching-message crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
