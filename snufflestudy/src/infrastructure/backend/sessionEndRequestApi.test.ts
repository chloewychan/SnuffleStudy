import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import {
  createRequest,
  resolveRequest,
  fetchRelevantSessionEndRequests,
  pollRelevantSessionEndRequests,
  isApprovedForSelf,
} from "./sessionEndRequestApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// unlockRequestApi.test.ts (this file mirrors it closely - see sessionEndRequestApi.ts's own
// header comment for why).
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors unlockRequestApi.test.ts's
// makeBuilder exactly.
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
  id: "end-req-1",
  session_id: "session-1",
  requester_user_id: "user-a",
  status: "pending",
  requested_at: "2026-01-01T00:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
};

describe("sessionEndRequestApi.createRequest", () => {
  it("inserts a pending session_end_requests row for the current user, and returns the mapped result", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await createRequest("session-1");

    expect(fromSpy).toHaveBeenCalledWith("session_end_requests");
    expect(builder.insert).toHaveBeenCalledWith({
      session_id: "session-1",
      requester_user_id: "user-a",
      status: "pending",
    });
    expect(result).toEqual({
      id: "end-req-1",
      sessionId: "session-1",
      requesterUserId: "user-a",
      status: "pending",
      requestedAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(createRequest("session-1")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws with the Postgres error message when the insert fails", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "insert failed" } }) as never
    );

    await expect(createRequest("session-1")).rejects.toThrow("insert failed");
  });
});

describe("sessionEndRequestApi.resolveRequest", () => {
  it("updates status/resolved_at/resolved_by for the current user, and resolves on success", async () => {
    mockGetUser("user-b");
    const resolvedRow = { ...sampleRow, status: "approved", resolved_by: "user-b" };
    const builder = makeBuilder({ data: resolvedRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await resolveRequest("end-req-1", "approved");

    expect(fromSpy).toHaveBeenCalledWith("session_end_requests");
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "approved",
        resolved_by: "user-b",
        resolved_at: expect.any(String),
      })
    );
    expect(builder.eq).toHaveBeenCalledWith("id", "end-req-1");
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(resolveRequest("end-req-1", "approved")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  // "First responder wins": mirrors unlockRequestApi.test.ts's identical case - once a request is
  // no longer pending, the RLS UPDATE policy's USING clause excludes the row for any non-requester
  // (supabase/migrations/20260815000038_v3.3_session_end_requests.sql), matching zero rows, which
  // .select().single() turns into an error this function surfaces as a throw.
  it("throws (does not silently succeed) when the update matches zero rows - e.g. a second friend racing to resolve an already-resolved request", async () => {
    mockGetUser("user-c");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned" },
      }) as never
    );

    await expect(resolveRequest("end-req-1", "approved")).rejects.toThrow();
  });
});

describe("sessionEndRequestApi.fetchRelevantSessionEndRequests", () => {
  it("selects session_end_requests newer (by requested_at or resolved_at) than sinceTimestamp, mapped to camelCase", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [sampleRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const since = new Date("2025-12-31T00:00:00.000Z").getTime();
    const result = await fetchRelevantSessionEndRequests(since);

    expect(fromSpy).toHaveBeenCalledWith("session_end_requests");
    expect(builder.or).toHaveBeenCalledWith(
      `requested_at.gt.${new Date(since).toISOString()},resolved_at.gt.${new Date(since).toISOString()}`
    );
    expect(result).toEqual([
      {
        id: "end-req-1",
        sessionId: "session-1",
        requesterUserId: "user-a",
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

    const result = await fetchRelevantSessionEndRequests(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a query error", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchRelevantSessionEndRequests(0);

    expect(result).toEqual([]);
  });
});

describe("sessionEndRequestApi.pollRelevantSessionEndRequests", () => {
  it("returns ok: true with the mapped requests on a successful query", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: [sampleRow], error: null }) as never
    );

    const result = await pollRelevantSessionEndRequests(0);

    expect(result).toEqual({
      ok: true,
      requests: [
        {
          id: "end-req-1",
          sessionId: "session-1",
          requesterUserId: "user-a",
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

    const result = await pollRelevantSessionEndRequests(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, requests: [] });
  });

  it("returns ok: false (distinct from a genuine empty result) on a query error, and does not throw", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollRelevantSessionEndRequests(0);

    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false when getSession itself throws, and does not throw", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollRelevantSessionEndRequests(0);

    expect(result).toEqual({ ok: false });
  });
});

// Security-critical - see this function's own header comment (sessionEndRequestApi.ts) and
// supabase/migrations/20260815000038_v3.3_session_end_requests.sql's header comment for the full
// reasoning. These tests are mocked at the supabase-js boundary (the actual RLS enforcement/live
// negative case is proven separately, live, per this task's report) - what's under test here is
// isApprovedForSelf's own logic: it must compare the freshly-read row's requester_user_id against
// the CALLER's own freshly-verified identity (requireUserId()), not trust anything else.
describe("sessionEndRequestApi.isApprovedForSelf", () => {
  it("returns true when the row is approved, the sessionId matches, and the caller IS the requester", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({
      data: { session_id: "session-1", status: "approved", requester_user_id: "user-a" },
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await isApprovedForSelf("end-req-1", "session-1");

    expect(fromSpy).toHaveBeenCalledWith("session_end_requests");
    expect(builder.select).toHaveBeenCalledWith("session_id, status, requester_user_id");
    expect(builder.eq).toHaveBeenCalledWith("id", "end-req-1");
    expect(result).toBe(true);
  });

  // The negative case this function exists for: RLS legitimately lets the RESOLVING FRIEND read
  // this row (resolved_by = auth.uid()), so a mocked "row exists and is approved" read alone is
  // not enough to prove safety - the caller must ALSO be the requester, not merely someone who can
  // see the row.
  it("returns false when the row is approved for someone else - the caller is not the requester (this is the negative case the plan's DoD names)", async () => {
    mockGetUser("user-b"); // user-b is the resolving friend, NOT the requester.
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({
        data: { session_id: "session-1", status: "approved", requester_user_id: "user-a" },
        error: null,
      }) as never
    );

    const result = await isApprovedForSelf("end-req-1", "session-1");

    expect(result).toBe(false);
  });

  it("returns false when the row is still pending", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({
        data: { session_id: "session-1", status: "pending", requester_user_id: "user-a" },
        error: null,
      }) as never
    );

    expect(await isApprovedForSelf("end-req-1", "session-1")).toBe(false);
  });

  it("returns false when the row was denied", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({
        data: { session_id: "session-1", status: "denied", requester_user_id: "user-a" },
        error: null,
      }) as never
    );

    expect(await isApprovedForSelf("end-req-1", "session-1")).toBe(false);
  });

  it("returns false when the sessionId doesn't match (a stale/mismatched approval)", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({
        data: { session_id: "some-other-session", status: "approved", requester_user_id: "user-a" },
        error: null,
      }) as never
    );

    expect(await isApprovedForSelf("end-req-1", "session-1")).toBe(false);
  });

  it("returns false (does not throw) when the row can't be read at all (RLS-denied or missing)", async () => {
    mockGetUser("user-c");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "no rows" } }) as never
    );

    expect(await isApprovedForSelf("end-req-1", "session-1")).toBe(false);
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(isApprovedForSelf("end-req-1", "session-1")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });
});
