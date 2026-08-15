import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import { fetchDigestForDate, pollNewDigests } from "./digestApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// nudgeApi.test.ts/unlockRequestApi.test.ts/sessionStatusSyncApi.test.ts.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors nudgeApi.test.ts's makeBuilder.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    gt: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    select: vi.fn(),
    eq: vi.fn(),
    gt: vi.fn(),
    order: vi.fn(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.gt.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  return builder;
}

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

const sampleRow = {
  subject_user_id: "user-friend",
  digest_date: "2026-08-14",
  completed_sessions: 3,
  abandoned_sessions: 1,
  distraction_count: 4,
  recovery_rate: 0.75,
  computed_at: "2026-08-15T00:05:00.000Z",
};

describe("digestApi.fetchDigestForDate", () => {
  it("selects daily_digests filtered by digest_date, mapped to the DigestSummary shape (subject_user_id -> friendUserId)", async () => {
    mockSignedIn("user-self");
    const builder = makeBuilder({ data: [sampleRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await fetchDigestForDate("2026-08-14");

    expect(fromSpy).toHaveBeenCalledWith("daily_digests");
    expect(builder.eq).toHaveBeenCalledWith("digest_date", "2026-08-14");
    expect(result).toEqual([
      {
        friendUserId: "user-friend",
        completedSessions: 3,
        abandonedSessions: 1,
        distractionCount: 4,
        recoveryRate: 0.75,
      },
    ]);
  });

  // Documented judgment call (this task's report): fetchDigestForDate does not filter out the
  // caller's own row - it returns exactly what RLS allows, same convention as
  // fetchNewEventsForFriends. FriendGroupPanel.tsx is the layer that filters self out for
  // display.
  it("includes the caller's own row when RLS returns one (does not filter it out itself)", async () => {
    mockSignedIn("user-self");
    const ownRow = { ...sampleRow, subject_user_id: "user-self" };
    vi.spyOn(supabase, "from").mockReturnValue(makeBuilder({ data: [ownRow], error: null }) as never);

    const result = await fetchDigestForDate("2026-08-14");

    expect(result).toEqual([
      expect.objectContaining({ friendUserId: "user-self" }),
    ]);
  });

  it("returns [] when there is no authenticated session", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await fetchDigestForDate("2026-08-14");

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a query error", async () => {
    mockSignedIn("user-self");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchDigestForDate("2026-08-14");

    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) when the auth check itself fails", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchDigestForDate("2026-08-14");

    expect(result).toEqual([]);
  });

  it("returns nothing for a date with no seeded digest rows (not stale data from a different date)", async () => {
    mockSignedIn("user-self");
    vi.spyOn(supabase, "from").mockReturnValue(makeBuilder({ data: [], error: null }) as never);

    const result = await fetchDigestForDate("2026-08-13");

    expect(result).toEqual([]);
  });
});

// Fix-round-1 discipline from Task 6 (see sessionStatusSyncApi.ts's pollNewEventsForFriends
// comment), applied here from the start per this task's own brief - alarmHandlers.ts's
// friend-poll alarm needs to distinguish "the fetch failed" from "genuinely nothing new" so it
// only advances its persisted digest cursor on confirmed success.
describe("digestApi.pollNewDigests", () => {
  it("selects daily_digests newer (by computed_at) than sinceTimestamp, mapped with digestDate/computedAt included", async () => {
    mockSignedIn("user-self");
    const builder = makeBuilder({ data: [sampleRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const since = new Date("2026-08-14T00:00:00.000Z").getTime();
    const result = await pollNewDigests(since);

    expect(fromSpy).toHaveBeenCalledWith("daily_digests");
    expect(builder.gt).toHaveBeenCalledWith("computed_at", new Date(since).toISOString());
    expect(result).toEqual({
      ok: true,
      digests: [
        {
          friendUserId: "user-friend",
          completedSessions: 3,
          abandonedSessions: 1,
          distractionCount: 4,
          recoveryRate: 0.75,
          digestDate: "2026-08-14",
          computedAt: new Date("2026-08-15T00:05:00.000Z").getTime(),
        },
      ],
    });
  });

  it("returns ok: true with digests: [] when there is no authenticated session (a legitimate empty state, not a failure to retry)", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await pollNewDigests(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, digests: [] });
  });

  it("returns ok: false (distinct from a genuine empty result) on a query error, and does not throw", async () => {
    mockSignedIn("user-self");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollNewDigests(0);

    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false when getSession itself throws, and does not throw", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollNewDigests(0);

    expect(result).toEqual({ ok: false });
  });
});
