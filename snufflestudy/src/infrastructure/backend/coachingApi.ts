import { supabase } from "./supabaseClient";
import type { InterventionLevel } from "../../domain/session/sessionTypes";
import { pickWarningMessage } from "../../domain/pressure/pressureEngine";

// v2 Task 11: Dynamic Coach Coaching Messages. Same request shape the generate-coaching-message
// Edge Function expects (supabase/functions/generate-coaching-message/index.ts) - see that
// file's header comment for the full round trip.
export interface CoachingMessageRequest {
  pressureProfileId: string;
  goal: string;
  hostname: string;
  interventionLevel: InterventionLevel;
}

// Per this task's brief's suggested figure. Chosen to comfortably exceed typical Edge Function
// latency for a short generation while still being well under the timescale a user would notice
// as "the warning UI is stalled" - SnufflesOverlay never blocks on this value either way (it
// always renders pickWarningMessage() immediately and only swaps text in if this resolves
// before dismissal), so the exact number mainly trades off "how often does the real line arrive
// in time to be seen" against "how long do we keep a network call alive in the background."
const INVOKE_TIMEOUT_MS = 800;

// Mirrors sessionStatusSyncApi.ts's/nudgeApi.ts's/unlockRequestApi.ts's checkAuth() exactly (see
// those files' identical comment) - reads the already-persisted/cached session via
// supabase.auth.getSession() rather than .getUser(), so a signed-out user pays no network round
// trip before this function falls back to the static pool.
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

// Resolves after `ms` milliseconds with a sentinel object (never rejects) - used to race against
// the real supabase.functions.invoke(...) call below via Promise.race. A plain setTimeout-based
// rejection would work too, but a resolving sentinel keeps the race's result type a plain
// discriminated union instead of needing a try/catch just to distinguish "timed out" from "every
// other outcome", which are handled identically here anyway (both fall back).
function timeoutSentinel(ms: number): Promise<{ timedOut: true }> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), ms);
  });
}

// generateCoachingMessage owns the entire timeout-and-fallback-to-pickWarningMessage() behavior
// itself, per this task's brief - it must ALWAYS resolve to a string and must NEVER reject, so
// SnufflesOverlay only ever calls this one function and always gets something back, whether that
// something is a freshly generated line or v1's static pool. Every failure path below (signed
// out, auth check itself failed, timeout, network/invoke error, non-2xx response including the
// Edge Function's 429 rate-limit, or a malformed/empty success body) falls back identically -
// this function's callers never need to distinguish why a message came from the static pool.
export async function generateCoachingMessage(request: CoachingMessageRequest): Promise<string> {
  const fallback = () => pickWarningMessage(request.pressureProfileId, request.interventionLevel);

  try {
    const auth = await checkAuth();
    if (!auth.ok || !auth.userId) return fallback(); // Not signed in, or the auth check itself failed.

    // supabase.functions.invoke(...) automatically forwards the caller's bearer token (from the
    // already-checked auth session above) as the Authorization header - the Edge Function's
    // per-user rate limiting depends on this being present.
    const racedResult = await Promise.race([
      supabase.functions.invoke<{ message?: string }>("generate-coaching-message", {
        body: request,
      }),
      timeoutSentinel(INVOKE_TIMEOUT_MS),
    ]);

    if ("timedOut" in racedResult) return fallback();

    const { data, error } = racedResult;
    if (error) {
      // Covers every non-2xx response the Edge Function can return, including its 429
      // rate-limited response - supabase-js surfaces a non-2xx as `error`, not a thrown
      // exception, so this branch (not the outer catch) is the normal path for that case.
      console.error("generate-coaching-message failed, falling back to static pool", error);
      return fallback();
    }
    const message = data?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      console.error("generate-coaching-message returned no usable message, falling back to static pool");
      return fallback();
    }

    return message;
  } catch (err) {
    // Covers a genuine thrown/rejected invoke (e.g. offline) and any other unexpected failure.
    console.error("Failed to generate coaching message, falling back to static pool", err);
    return fallback();
  }
}
