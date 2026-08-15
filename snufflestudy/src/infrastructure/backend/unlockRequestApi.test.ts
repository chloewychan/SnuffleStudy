import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import {
  createRequest,
  resolveRequest,
  fetchRelevantUnlockRequests,
  pollRelevantUnlockRequests,
} from "./unlockRequestApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// nudgeApi.test.ts/sessionStatusSyncApi.test.ts.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors nudgeApi.test.ts's makeBuilder,
// extended with `or` since queryRelevantSince uses it.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    or: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    single: vi.fn(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.insert.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.or.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.single.mockReturnValue(builder);
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

function mockGetUser(userId: string | null) {
  return vi.spyOn(supabase.auth, "getUser").mockResolvedValue(
    (userId
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: { message: "Not signed in." } }) as never
  );
}

const sampleRow = {
  id: "req-1",
  session_id: "session-1",
  requester_user_id: "user-a",
  hostname: "youtube.com",
  status: "pending",
  requested_at: "2026-01-01T00:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
};

describe("unlockRequestApi.createRequest", () => {
  it("inserts a pending unlock_requests row for the current user, and returns the mapped result", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await createRequest("session-1", "youtube.com");

    expect(fromSpy).toHaveBeenCalledWith("unlock_requests");
    expect(builder.insert).toHaveBeenCalledWith({
      session_id: "session-1",
      requester_user_id: "user-a",
      hostname: "youtube.com",
      status: "pending",
    });
    expect(result).toEqual({
      id: "req-1",
      sessionId: "session-1",
      requesterUserId: "user-a",
      hostname: "youtube.com",
      status: "pending",
      requestedAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(createRequest("session-1", "youtube.com")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws with the Postgres error message when the insert fails", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "insert failed" } }) as never
    );

    await expect(createRequest("session-1", "youtube.com")).rejects.toThrow("insert failed");
  });
});

describe("unlockRequestApi.resolveRequest", () => {
  it("updates status/resolved_at/resolved_by for the current user, and resolves on success", async () => {
    mockGetUser("user-b");
    const resolvedRow = { ...sampleRow, status: "approved", resolved_by: "user-b" };
    const builder = makeBuilder({ data: resolvedRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await resolveRequest("req-1", "approved");

    expect(fromSpy).toHaveBeenCalledWith("unlock_requests");
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "approved",
        resolved_by: "user-b",
        resolved_at: expect.any(String),
      })
    );
    expect(builder.eq).toHaveBeenCalledWith("id", "req-1");
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(resolveRequest("req-1", "approved")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  // "First responder wins": once a request is no longer pending, the RLS UPDATE policy's USING
  // clause excludes the row for any non-requester (supabase/migrations/
  // 20260815000008_v2_unlock_request_group_visibility.sql) - the update matches zero rows, which
  // is NOT a Postgres error on its own. .select().single() turns that into an error this
  // function surfaces as a throw, which is the behavior under test here (mocked at the
  // supabase-js boundary, since the actual RLS enforcement itself is proven live by
  // scripts/verify-unlock-requests.mjs, not by this unit test).
  it("throws (does not silently succeed) when the update matches zero rows - e.g. a second friend racing to resolve an already-resolved request", async () => {
    mockGetUser("user-c");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned" },
      }) as never
    );

    await expect(resolveRequest("req-1", "approved")).rejects.toThrow();
  });
});

describe("unlockRequestApi.fetchRelevantUnlockRequests", () => {
  it("selects unlock_requests newer (by requested_at or resolved_at) than sinceTimestamp, mapped to camelCase", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [sampleRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const since = new Date("2025-12-31T00:00:00.000Z").getTime();
    const result = await fetchRelevantUnlockRequests(since);

    expect(fromSpy).toHaveBeenCalledWith("unlock_requests");
    expect(builder.or).toHaveBeenCalledWith(
      `requested_at.gt.${new Date(since).toISOString()},resolved_at.gt.${new Date(since).toISOString()}`
    );
    expect(result).toEqual([
      {
        id: "req-1",
        sessionId: "session-1",
        requesterUserId: "user-a",
        hostname: "youtube.com",
        status: "pending",
        requestedAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
        resolvedAt: null,
        resolvedBy: null,
      },
    ]);
  });

  it("returns [] when there is no authenticated session", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await fetchRelevantUnlockRequests(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a query error", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchRelevantUnlockRequests(0);

    expect(result).toEqual([]);
  });
});

// Fix-round-1 discipline from Task 6 (see sessionStatusSyncApi.ts's pollNewEventsForFriends
// comment), applied here from the start per this task's own brief - alarmHandlers.ts's
// friend-poll alarm needs to distinguish "the fetch failed" from "genuinely nothing new" so it
// only advances its persisted unlock-request cursor on confirmed success.
describe("unlockRequestApi.pollRelevantUnlockRequests", () => {
  it("returns ok: true with the mapped requests on a successful query", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: [sampleRow], error: null }) as never
    );

    const result = await pollRelevantUnlockRequests(0);

    expect(result).toEqual({
      ok: true,
      requests: [
        {
          id: "req-1",
          sessionId: "session-1",
          requesterUserId: "user-a",
          hostname: "youtube.com",
          status: "pending",
          requestedAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
    });
  });

  it("returns ok: true with requests: [] when there is no authenticated session (a legitimate empty state, not a failure to retry)", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await pollRelevantUnlockRequests(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, requests: [] });
  });

  it("returns ok: false (distinct from a genuine empty result) on a query error, and does not throw", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollRelevantUnlockRequests(0);

    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false when getSession itself throws, and does not throw", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollRelevantUnlockRequests(0);

    expect(result).toEqual({ ok: false });
  });
});
