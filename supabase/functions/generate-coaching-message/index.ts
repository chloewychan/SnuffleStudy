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
const RATE_LIMIT_WINDOW_MS = 60_000;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
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
    const anonClient = createClient(supabaseUrl, anonKey);
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

    // Service-role client for the rate-limit ledger only - coaching_message_requests has no
    // RLS policies at all (see the migration), so only this service-role client can touch it.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const windowStartIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { count, error: countError } = await adminClient
      .from("coaching_message_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gt("requested_at", windowStartIso);
    if (countError) {
      console.error("Rate limit check failed", countError);
      return json({ error: "Server error" }, 500);
    }
    if ((count ?? 0) >= RATE_LIMIT_MAX_REQUESTS) {
      return json({ error: "Rate limited" }, 429);
    }

    // Record this admitted request BEFORE calling Claude, so a slow or hanging model call still
    // counts toward the caller's quota - the rate limiter bounds actual Claude spend, not just
    // request volume to this function. Denied (429) requests above are never recorded, so the
    // sliding window rolls forward normally instead of a burst of denials permanently pinning a
    // user at the ceiling.
    const { error: insertError } = await adminClient
      .from("coaching_message_requests")
      .insert({ user_id: userId });
    if (insertError) {
      // Non-fatal - proceed anyway rather than blocking the coaching line on bookkeeping. A
      // transient ledger-write failure should not itself trigger the client's fallback.
      console.error("Failed to record coaching message request", insertError);
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

    // Raw fetch to the Messages API (no Anthropic SDK dependency in this Deno function) - model
    // choice is claude-opus-5 per this environment's default-model policy (never downgrade for
    // cost without an explicit ask), with thinking disabled and effort held low since this is a
    // single short sentence with no tool use, where the two disabled-thinking failure modes
    // (tool-call-as-text, tag leakage) don't apply and low latency matters more than depth.
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 100,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
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

    // Claude Opus 5's elevated cybersecurity safeguards can return stop_reason: "refusal" with a
    // 200 and (possibly) empty content - treat that as a failure the client should fall back on,
    // not as a successful-but-empty message.
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

    return json({ message }, 200);
  } catch (err) {
    console.error("generate-coaching-message crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
