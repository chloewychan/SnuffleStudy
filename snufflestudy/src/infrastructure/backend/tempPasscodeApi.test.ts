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
  claimApproval,
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
  requested_at: "2026-01-01T00:00:00.000Z",
  resolved_at: null,
  message: null,
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
      expiresAt: 0,
      message: null,
    });
  });

  // v3.3 Task 11: the optional trailing `message` param is included in the insert body only when
  // provided (never as an explicit `message: undefined`) - a message-less call's insert body stays
  // byte-for-byte identical to the test right above.
  it("includes message in the insert body when provided, and maps it through on the returned request", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({
      data: { ...sampleRow, message: "Need to check the syllabus" },
      error: null,
    });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    mockInvoke(() => Promise.resolve({ data: { ok: true }, error: null }));

    const result = await createRequest(
      "session-1",
      "youtube.com",
      "user-b",
      "Need to check the syllabus"
    );

    expect(builder.insert).toHaveBeenCalledWith({
      session_id: "session-1",
      hostname: "youtube.com",
      requester_user_id: "user-a",
      friend_user_id: "user-b",
      status: "pending",
      delivered_via: "email+in_app",
      message: "Need to check the syllabus",
    });
    expect(result.message).toBe("Need to check the syllabus");
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

// Fix round 1 (Critical, code review): denyRequest no longer does a direct client-side table
// UPDATE (that path let ANY authenticated requester also self-approve their own request with a
// self-chosen code, bypassing approve-temp-passcode entirely - see tempPasscodeApi.ts's updated
// comment and migration 20260815000017_v2_temp_passcode_lock_down_client_writes.sql). It now
// calls the narrow deny_temp_passcode_request() SECURITY DEFINER RPC instead - these tests assert
// THAT call shape, not a table update.
describe("tempPasscodeApi.denyRequest", () => {
  it("calls the deny_temp_passcode_request RPC with the request id", async () => {
    mockGetUser("user-b");
    const rpcSpy = vi.spyOn(supabase, "rpc").mockResolvedValue({ data: null, error: null } as never);

    await denyRequest("req-1");

    expect(rpcSpy).toHaveBeenCalledWith("deny_temp_passcode_request", { p_request_id: "req-1" });
  });

  it("throws when the RPC reports an error (e.g. already resolved, or not the assigned friend)", async () => {
    mockGetUser("user-b");
    vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: null,
      error: {
        message:
          "Could not deny this request - it may already have been resolved, or you are not the assigned friend.",
      },
    } as never);

    await expect(denyRequest("req-1")).rejects.toThrow(/already have been resolved/);
  });

  it("never issues a direct table UPDATE against temp_passcode_requests (regression guard for the Critical finding)", async () => {
    mockGetUser("user-b");
    const fromSpy = vi.spyOn(supabase, "from");
    vi.spyOn(supabase, "rpc").mockResolvedValue({ data: null, error: null } as never);

    await denyRequest("req-1");

    expect(fromSpy).not.toHaveBeenCalled();
  });
});

describe("tempPasscodeApi.approveRequest", () => {
  it("invokes approve-temp-passcode and returns hostname/expiresAt, no code", async () => {
    const invokeMock = mockInvoke(() =>
      Promise.resolve({ data: { hostname: "youtube.com", expiresAt: 123 }, error: null })
    );

    const result = await approveRequest("req-1");

    expect(invokeMock).toHaveBeenCalledWith("approve-temp-passcode", { body: { requestId: "req-1" } });
    expect(result).toEqual({ hostname: "youtube.com", expiresAt: 123 });
  });

  it("throws when the Edge Function returns an error", async () => {
    mockInvoke(() => Promise.resolve({ data: null, error: { message: "Not authorized" } }));

    await expect(approveRequest("req-1")).rejects.toThrow("Not authorized");
  });

  it("throws when the response is missing hostname/expiresAt", async () => {
    mockInvoke(() => Promise.resolve({ data: {}, error: null }));

    await expect(approveRequest("req-1")).rejects.toThrow();
  });
});

// v3.3 Task 10, Decision 3: claimApproval replaces redeemCode - there is no code to submit
// anymore. It performs a fresh, RLS-gated read of the request row itself (never trusts a
// client-supplied hostname/expiry), then - on a genuinely approved, unexpired row - performs the
// actual unlock locally, same as redeemCode used to on a successful redemption.
describe("tempPasscodeApi.claimApproval", () => {
  function makeApprovedBuilder(overrides: Partial<{ hostname: string; status: string; expires_at: string | null }> = {}) {
    return makeBuilder({
      data: {
        hostname: "youtube.com",
        status: "approved",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        ...overrides,
      },
      error: null,
    });
  }

  it("on a genuinely approved, unexpired row, unlocks the hostname's DNR rule and schedules the re-lock alarm", async () => {
    const futureExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const builder = makeApprovedBuilder({ expires_at: futureExpiresAt });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    const unlockSpy = vi
      .spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname")
      .mockResolvedValue(undefined);
    const scheduleSpy = vi
      .spyOn(alarmsApi, "scheduleTempUnlockRelockAlarm")
      .mockImplementation(() => {});

    const result = await claimApproval("req-1");

    expect(result).toEqual({ ok: true });
    expect(builder.eq).toHaveBeenCalledWith("id", "req-1");
    expect(builder.eq).toHaveBeenCalledWith("status", "approved");
    expect(unlockSpy).toHaveBeenCalledWith("youtube.com");
    expect(scheduleSpy).toHaveBeenCalledWith("youtube.com", new Date(futureExpiresAt).getTime());
  });

  it("returns ok:false without unlocking anything when the row read is denied/missing (RLS, wrong id, not approved)", async () => {
    const builder = makeBuilder({ data: null, error: { message: "denied" } });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    const unlockSpy = vi.spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname");

    const result = await claimApproval("req-1");

    expect(result).toEqual({ ok: false });
    expect(unlockSpy).not.toHaveBeenCalled();
  });

  it("returns ok:false without unlocking anything when the row's expires_at has already passed", async () => {
    const builder = makeApprovedBuilder({ expires_at: new Date(Date.now() - 60_000).toISOString() });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    const unlockSpy = vi.spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname");

    const result = await claimApproval("req-1");

    expect(result).toEqual({ ok: false });
    expect(unlockSpy).not.toHaveBeenCalled();
  });

  it("returns ok:false, never throws, when the query itself throws", async () => {
    vi.spyOn(supabase, "from").mockImplementation(() => {
      throw new Error("offline");
    });

    await expect(claimApproval("req-1")).resolves.toEqual({ ok: false });
  });

  // Unlike the old redeemCode (which wrapped only its local-unlock step in a nested try/catch so a
  // DNR failure couldn't turn a genuine server-side redemption into a reported failure),
  // claimApproval's spec (Task 10's Interfaces block) wraps the whole body in one outer
  // try/catch - a thrown local-unlock error here is indistinguishable from any other failure and
  // correctly surfaces as ok:false, matching the plan's given implementation exactly.
  it("returns ok:false and logs when the local unlock step itself throws", async () => {
    const builder = makeApprovedBuilder({
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);
    vi.spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname").mockRejectedValue(
      new Error("DNR API unavailable")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await claimApproval("req-1");

    expect(result).toEqual({ ok: false });
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

  // v2 Task 12 regression test (mirrors sessionStatusSyncApi.test.ts's Task 10 regression test).
  // v3.3 Task 10: code_hash/code_salt/failed_attempts/locked_until no longer exist on this table
  // at all (migration 20260815000036_v3.3_temp_passcode_no_code.sql), so this now just pins the
  // exact narrowed column list - the live half is verify-temp-passcode.mjs's direct assertion
  // against the real table under RLS.
  it("selects only the fixed narrowed column list (no code_hash/code_salt/failed_attempts/locked_until)", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [], error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await pollRelevantTempPasscodeRequests(0);

    expect(builder.select).toHaveBeenCalledTimes(1);
    const selectArg = builder.select.mock.calls[0]![0] as string;
    expect(selectArg).not.toContain("code_hash");
    expect(selectArg).not.toContain("code_salt");
    expect(selectArg).not.toContain("failed_attempts");
    expect(selectArg).not.toContain("locked_until");
    expect(selectArg).toBe(
      "id, session_id, hostname, requester_user_id, friend_user_id, status, expires_at, " +
        "delivered_via, requested_at, resolved_at, message"
    );
  });
});
