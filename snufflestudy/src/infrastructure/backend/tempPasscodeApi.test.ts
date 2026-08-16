import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { supabase } from "./supabaseClient";
import * as declarativeNetRequestApi from "../browser/declarativeNetRequestApi";
import * as alarmsApi from "../browser/alarmsApi";
import { stubFakeDeclarativeNetRequest } from "../../background/testSupport/fakeDeclarativeNetRequest";
import {
  createRequest,
  denyRequest,
  approveRequest,
  redeemCode,
  fetchRelevantTempPasscodeRequests,
  pollRelevantTempPasscodeRequests,
} from "./tempPasscodeApi";

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeDeclarativeNetRequest();
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors unlockRequestApi.test.ts's
// makeBuilder exactly (same shape, extended with nothing new - this table's queries use the same
// insert/update/select/eq/or/order/single chain).
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

// supabase-js's SupabaseClient.functions is a GETTER that constructs a brand-new FunctionsClient
// on every access - mirrors coachingApi.test.ts's identical mockInvoke helper/comment exactly
// (spying on `supabase.functions.invoke` directly would silently miss the real call, since
// tempPasscodeApi.ts reads the getter again and gets a different instance).
function mockInvoke(impl: (...args: unknown[]) => Promise<unknown>) {
  const invokeMock = vi.fn(impl);
  vi.spyOn(supabase, "functions", "get").mockReturnValue({ invoke: invokeMock } as never);
  return invokeMock;
}

const sampleRow = {
  id: "req-1",
  session_id: "session-1",
  hostname: "youtube.com",
  requester_user_id: "user-a",
  friend_user_id: "user-b",
  status: "pending",
  expires_at: null,
  delivered_via: "email+in_app",
  failed_attempts: 0,
  locked_until: null,
  requested_at: "2026-01-01T00:00:00.000Z",
  resolved_at: null,
};

describe("tempPasscodeApi.createRequest", () => {
  it("inserts a pending row (delivered_via: email+in_app) and returns the mapped request", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    mockInvoke(() => Promise.resolve({ data: { ok: true }, error: null }));

    const result = await createRequest("session-1", "youtube.com", "user-b");

    expect(fromSpy).toHaveBeenCalledWith("temp_passcode_requests");
    expect(builder.insert).toHaveBeenCalledWith({
      session_id: "session-1",
      hostname: "youtube.com",
      requester_user_id: "user-a",
      friend_user_id: "user-b",
      status: "pending",
      delivered_via: "email+in_app",
    });
    expect(result).toEqual({
      id: "req-1",
      sessionId: "session-1",
      hostname: "youtube.com",
      friendUserId: "user-b",
      requesterUserId: "user-a",
      status: "pending",
      codeHash: "",
      codeSalt: "",
      expiresAt: 0,
      failedAttempts: 0,
      lockedUntil: undefined,
    });
  });

  it("never selects code_hash/code_salt when inserting", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    mockInvoke(() => Promise.resolve({ data: { ok: true }, error: null }));

    await createRequest("session-1", "youtube.com", "user-b");

    const selectArg = builder.select.mock.calls[0]![0] as string;
    expect(selectArg).not.toContain("code_hash");
    expect(selectArg).not.toContain("code_salt");
  });

  it("invokes send-temp-passcode-request fire-and-forget, without blocking on its result", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    const invokeMock = mockInvoke(() => Promise.reject(new Error("email service down")));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createRequest("session-1", "youtube.com", "user-b");

    // createRequest already resolved successfully despite the invoke rejecting - proves the
    // email leg is genuinely fire-and-forget, not awaited.
    expect(result.id).toBe("req-1");
    expect(invokeMock).toHaveBeenCalledWith("send-temp-passcode-request", {
      body: { requestId: "req-1" },
    });
    // Let the rejected fire-and-forget promise's .catch() run before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("throws when not signed in", async () => {
    mockGetUser(null);
    await expect(createRequest("session-1", "youtube.com", "user-b")).rejects.toThrow(
      "Not signed in."
    );
  });

  it("throws when the insert fails", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: null, error: { message: "insert failed" } });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await expect(createRequest("session-1", "youtube.com", "user-b")).rejects.toThrow(
      "insert failed"
    );
  });
});

describe("tempPasscodeApi.denyRequest", () => {
  it("updates status to denied, scoped to the still-pending row", async () => {
    mockGetUser("user-b");
    const builder = makeBuilder({ data: { ...sampleRow, status: "denied" }, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await denyRequest("req-1");

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" })
    );
    expect(builder.eq).toHaveBeenCalledWith("id", "req-1");
    expect(builder.eq).toHaveBeenCalledWith("status", "pending");
  });

  it("throws when the request was already resolved (zero rows matched)", async () => {
    mockGetUser("user-b");
    const builder = makeBuilder({ data: null, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await expect(denyRequest("req-1")).rejects.toThrow(/already have been resolved/);
  });
});

describe("tempPasscodeApi.approveRequest", () => {
  it("invokes approve-temp-passcode and returns the plaintext code", async () => {
    const invokeMock = mockInvoke(() =>
      Promise.resolve({ data: { code: "483920", hostname: "youtube.com", expiresAt: 123 }, error: null })
    );

    const result = await approveRequest("req-1");

    expect(invokeMock).toHaveBeenCalledWith("approve-temp-passcode", { body: { requestId: "req-1" } });
    expect(result).toEqual({ code: "483920" });
  });

  it("throws when the Edge Function returns an error", async () => {
    mockInvoke(() => Promise.resolve({ data: null, error: { message: "Not authorized" } }));

    await expect(approveRequest("req-1")).rejects.toThrow("Not authorized");
  });

  it("throws when the response has no code", async () => {
    mockInvoke(() => Promise.resolve({ data: {}, error: null }));

    await expect(approveRequest("req-1")).rejects.toThrow();
  });
});

describe("tempPasscodeApi.redeemCode", () => {
  it("on a successful redemption, unlocks the hostname's DNR rule and schedules the re-lock alarm", async () => {
    mockInvoke(() =>
      Promise.resolve({
        data: { ok: true, hostname: "youtube.com", expiresAt: 1_800_000_000_000 },
        error: null,
      })
    );
    const unlockSpy = vi
      .spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname")
      .mockResolvedValue(undefined);
    const scheduleSpy = vi
      .spyOn(alarmsApi, "scheduleTempUnlockRelockAlarm")
      .mockImplementation(() => {});

    const result = await redeemCode("req-1", "483920");

    expect(result).toEqual({ ok: true });
    expect(unlockSpy).toHaveBeenCalledWith("youtube.com");
    expect(scheduleSpy).toHaveBeenCalledWith("youtube.com", 1_800_000_000_000);
  });

  it("returns ok:false without unlocking anything when the Edge Function reports a logical failure", async () => {
    mockInvoke(() => Promise.resolve({ data: { ok: false, error: "Incorrect code" }, error: null }));
    const unlockSpy = vi.spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname");

    const result = await redeemCode("req-1", "000000");

    expect(result).toEqual({ ok: false });
    expect(unlockSpy).not.toHaveBeenCalled();
  });

  it("returns ok:false when the invoke itself errors (non-2xx / network)", async () => {
    mockInvoke(() => Promise.resolve({ data: null, error: { message: "network error" } }));

    const result = await redeemCode("req-1", "483920");

    expect(result).toEqual({ ok: false });
  });

  it("returns ok:false, never throws, when invoke rejects outright", async () => {
    mockInvoke(() => Promise.reject(new Error("offline")));

    await expect(redeemCode("req-1", "483920")).resolves.toEqual({ ok: false });
  });

  it("still reports ok:true (server-side success already recorded) even if the local unlock step itself throws", async () => {
    mockInvoke(() =>
      Promise.resolve({
        data: { ok: true, hostname: "youtube.com", expiresAt: 1_800_000_000_000 },
        error: null,
      })
    );
    vi.spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname").mockRejectedValue(
      new Error("DNR API unavailable")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await redeemCode("req-1", "483920");

    expect(result).toEqual({ ok: true });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("tempPasscodeApi.fetchRelevantTempPasscodeRequests / pollRelevantTempPasscodeRequests", () => {
  it("fetchRelevantTempPasscodeRequests returns [] when signed out (no error)", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await fetchRelevantTempPasscodeRequests(0);

    expect(result).toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("fetchRelevantTempPasscodeRequests maps returned rows", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [sampleRow], error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await fetchRelevantTempPasscodeRequests(0);

    expect(result).toEqual([
      expect.objectContaining({ id: "req-1", hostname: "youtube.com", status: "pending" }),
    ]);
  });

  it("pollRelevantTempPasscodeRequests returns ok:false when the auth check itself fails (not a clean sign-out)", async () => {
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: { message: "invalid refresh token" },
    } as never);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollRelevantTempPasscodeRequests(0);

    expect(result).toEqual({ ok: false });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("pollRelevantTempPasscodeRequests returns ok:false when the query itself fails", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: null, error: { message: "query failed" } });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollRelevantTempPasscodeRequests(0);

    expect(result).toEqual({ ok: false });
  });

  it("pollRelevantTempPasscodeRequests returns ok:true with mapped requests on success", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [sampleRow], error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await pollRelevantTempPasscodeRequests(0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]!.id).toBe("req-1");
    }
  });

  // v2 Task 12 regression test (mirrors sessionStatusSyncApi.test.ts's Task 10 regression test):
  // proves the fetch never requests code_hash/code_salt, regardless of caller - this is the
  // client-side half of the DoD's explicit requirement ("confirm temp_passcode_requests.code_hash
  // is never queryable ... from the client"); the live half is verify-temp-passcode.mjs's direct
  // assertion against the real table under RLS/column grants.
  it("never requests code_hash/code_salt - selects only the fixed narrowed column list", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [], error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await pollRelevantTempPasscodeRequests(0);

    expect(builder.select).toHaveBeenCalledTimes(1);
    const selectArg = builder.select.mock.calls[0]![0] as string;
    expect(selectArg).not.toContain("code_hash");
    expect(selectArg).not.toContain("code_salt");
    expect(selectArg).toBe(
      "id, session_id, hostname, requester_user_id, friend_user_id, status, expires_at, " +
        "delivered_via, failed_attempts, locked_until, requested_at, resolved_at"
    );
  });
});
