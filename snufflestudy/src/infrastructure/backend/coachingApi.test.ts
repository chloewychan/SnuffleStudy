import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { supabase } from "./supabaseClient";
import { generateCoachingMessage, type CoachingMessageRequest } from "./coachingApi";
import { pickWarningMessage } from "../../domain/pressure/pressureEngine";

// pickWarningMessage is mocked wholesale (rather than exercised for real, unlike
// SnufflesOverlay.test.tsx's deliberate choice to run it for real) - this file's job is proving
// generateCoachingMessage's OWN timeout-and-fallback contract ("always resolve to a string, never
// reject, call pickWarningMessage on every failure path"), not re-testing pickWarningMessage's
// own pool-selection logic (already covered by pressureEngine.test.ts).
vi.mock("../../domain/pressure/pressureEngine", () => ({
  pickWarningMessage: vi.fn(() => "STATIC_FALLBACK_LINE"),
}));

const REQUEST: CoachingMessageRequest = {
  pressureProfileId: "strict-coach",
  goal: "Finish Chapter 6 of STAT231",
  hostname: "youtube.com",
  interventionLevel: "warned",
};

// Mirrors nudgeApi.test.ts's/sessionStatusSyncApi.test.ts's mockSignedIn/mockSignedOut helpers
// exactly - same auth boundary (supabase.auth.getSession), same spy target.
function mockSignedIn(userId: string) {
  return vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session: { user: { id: userId } } },
    error: null,
  } as never);
}

function mockSignedOut() {
  return vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session: null },
    error: null,
  } as never);
}

// supabase-js's SupabaseClient.functions is a GETTER that constructs a brand-new FunctionsClient
// on every access (node_modules/@supabase/supabase-js/src/SupabaseClient.ts) - a plain
// `vi.spyOn(supabase.functions, "invoke")` therefore spies on one throwaway instance while
// coachingApi.ts's own `supabase.functions.invoke(...)` call reads the getter again and gets a
// DIFFERENT instance, so the spy is silently never hit and the real network call fires instead.
// Spying on the GETTER itself (third arg "get") and returning a fixed stub object is the fix -
// every subsequent `supabase.functions` read (in this test file and inside coachingApi.ts alike)
// then resolves to the same stubbed `{ invoke }` object.
function mockInvoke(impl: (...args: unknown[]) => Promise<unknown>) {
  const invokeMock = vi.fn(impl);
  vi.spyOn(supabase, "functions", "get").mockReturnValue({ invoke: invokeMock } as never);
  return invokeMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(pickWarningMessage).mockReturnValue("STATIC_FALLBACK_LINE");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("coachingApi.generateCoachingMessage", () => {
  it("returns the generated message on a successful invoke", async () => {
    mockSignedIn("user-1");
    const invokeSpy = mockInvoke(() =>
      Promise.resolve({
        data: { message: "Chapter 6 is calling your name - back to it." },
        error: null,
      })
    );

    const result = await generateCoachingMessage(REQUEST);

    expect(invokeSpy).toHaveBeenCalledWith("generate-coaching-message", { body: REQUEST });
    expect(result).toBe("Chapter 6 is calling your name - back to it.");
    expect(pickWarningMessage).not.toHaveBeenCalled();
  });

  it("falls back to pickWarningMessage (never throws) when the Edge Function returns a non-2xx error, e.g. the 429 rate-limit response", async () => {
    mockSignedIn("user-1");
    mockInvoke(() =>
      Promise.resolve({
        data: null,
        error: { message: "Rate limited", context: { status: 429 } },
      })
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateCoachingMessage(REQUEST);

    expect(result).toBe("STATIC_FALLBACK_LINE");
    expect(pickWarningMessage).toHaveBeenCalledWith("strict-coach", "warned");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("falls back to pickWarningMessage (never throws) when invoke itself rejects (e.g. offline)", async () => {
    mockSignedIn("user-1");
    mockInvoke(() => Promise.reject(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateCoachingMessage(REQUEST);

    expect(result).toBe("STATIC_FALLBACK_LINE");
  });

  it("falls back to pickWarningMessage when invoke succeeds but the response body has no usable message", async () => {
    mockSignedIn("user-1");
    mockInvoke(() => Promise.resolve({ data: { message: "   " }, error: null }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateCoachingMessage(REQUEST);

    expect(result).toBe("STATIC_FALLBACK_LINE");
  });

  it("falls back to pickWarningMessage without calling functions.invoke when there is no authenticated session", async () => {
    mockSignedOut();
    const invokeSpy = mockInvoke(() => Promise.resolve({ data: null, error: null }));

    const result = await generateCoachingMessage(REQUEST);

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(result).toBe("STATIC_FALLBACK_LINE");
  });

  it("falls back to pickWarningMessage (does not throw) when the auth check itself fails", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("boom"));
    const invokeSpy = mockInvoke(() => Promise.resolve({ data: null, error: null }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateCoachingMessage(REQUEST);

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(result).toBe("STATIC_FALLBACK_LINE");
  });

  it("falls back to pickWarningMessage once the ~2000ms timeout elapses, even if invoke would eventually have succeeded", async () => {
    // 2000ms per fix round 2 (raised from the plan's suggested 800ms - see coachingApi.ts's
    // INVOKE_TIMEOUT_MS comment and task-11-report.md's Fix round 1/2 sections for why).
    vi.useFakeTimers();
    mockSignedIn("user-1");
    // Never resolves within this test's lifetime - simulates a slow Edge Function/model call.
    mockInvoke(() => new Promise(() => {}));

    const resultPromise = generateCoachingMessage(REQUEST);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result).toBe("STATIC_FALLBACK_LINE");
  });

  // Fix round 1: pickWarningMessage() itself throws for any pressureProfileId outside the six
  // known PRESSURE_PROFILES entries (getPressureProfile(), pressureProfiles.ts:110-113) -
  // StudySession.pressureProfileId is a bare `string`, not a literal union, so a stale/legacy/
  // corrupted session can genuinely carry an id that no longer matches. Before this fix,
  // generateCoachingMessage's own fallback() call had no protection against this - the throw
  // propagated straight out, breaking the "always resolves to a string, never throws" contract
  // for exactly the input that contract exists to guard against.
  it("resolves to a hardcoded last-resort message (never throws) when pickWarningMessage itself throws - e.g. a stale session with an unrecognized pressureProfileId", async () => {
    mockSignedOut(); // simplest deterministic path to fallback() - no invoke mocking needed
    vi.mocked(pickWarningMessage).mockImplementation(() => {
      throw new Error("Unknown pressure profile: not-a-real-profile-id");
    });

    await expect(generateCoachingMessage(REQUEST)).resolves.toBe("Back to it.");
  });

  it("resolves to a hardcoded last-resort message (never throws) when pickWarningMessage throws from inside the outer catch block's own fallback() call", async () => {
    // Reaches the specific code path the fix targets: invoke itself rejects (landing in the
    // outer catch), and THAT catch block's own fallback() call is what throws - there is no
    // further try/catch around that specific call site unless fallback() protects itself.
    mockSignedIn("user-1");
    mockInvoke(() => Promise.reject(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pickWarningMessage).mockImplementation(() => {
      throw new Error("Unknown pressure profile: not-a-real-profile-id");
    });

    await expect(generateCoachingMessage(REQUEST)).resolves.toBe("Back to it.");
  });

  it("passes the pressureProfileId and interventionLevel from the request to pickWarningMessage on every fallback path", async () => {
    mockSignedOut();
    mockInvoke(() => Promise.resolve({ data: null, error: null }));

    await generateCoachingMessage({
      pressureProfileId: "ruthless-roaster",
      goal: "Finish the essay",
      hostname: "reddit.com",
      interventionLevel: "escalated",
    });

    expect(pickWarningMessage).toHaveBeenCalledWith("ruthless-roaster", "escalated");
  });
});
