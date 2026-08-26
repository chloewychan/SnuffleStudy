// Covers messageRouter.ts's v2 Task 12 additions (originally TEMP_PASSCODE_* cases, v3.4 Task 3:
// consolidated into FRIEND_REQUEST_*/FRIEND_REQUEST_APPROVE_TEMP_PASS/
// FRIEND_REQUEST_CLAIM_TEMP_PASS, exercised here with kind: "site_temp_pass" - site_unlock
// coverage lives in messageRouterAccountability.test.ts, session_end in
// messageRouterSessionEnd.test.ts, retargeted the same way), mirroring
// messageRouterAccountability.test.ts's own convention exactly: spies on friendRequestApi's
// exported functions (this repo's established test style) so these cases are verified to route
// to the right underlying call with the right arguments, entirely offline - no real network call
// is ever made, and no chrome.declarativeNetRequest/chrome.alarms side effect is exercised here
// (friendRequestApi.claimApproval's own unit tests, friendRequestApi.test.ts, already cover that).
// v3.3 Task 10: approval's response no longer carries a code (approval alone is the security
// boundary now); the old TEMP_PASSCODE_REDEEM is replaced by FRIEND_REQUEST_CLAIM_TEMP_PASS.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import * as friendRequestApi from "../infrastructure/backend/friendRequestApi";
import type { FriendRequest } from "../domain/accountability/friendRequest";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

const sampleRequest: FriendRequest = {
  id: "req-1",
  kind: "site_temp_pass",
  sessionId: "session-1",
  hostname: "youtube.com",
  friendUserId: "user-b",
  requesterUserId: "user-a",
  status: "pending",
  requestedAt: Date.now(),
  resolvedAt: null,
  resolvedBy: null,
  expiresAt: null,
  message: null,
};

describe("messageRouter — FRIEND_REQUEST_* (site_temp_pass)", () => {
  it("FRIEND_REQUEST_CREATE routes to friendRequestApi.createRequest with kind/sessionId/hostname/friendUserId", async () => {
    const spy = vi.spyOn(friendRequestApi, "createRequest").mockResolvedValue(sampleRequest);

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CREATE",
      payload: {
        kind: "site_temp_pass",
        sessionId: "session-1",
        hostname: "youtube.com",
        friendUserId: "user-b",
      },
    })) as { ok: boolean; request: FriendRequest };

    expect(spy).toHaveBeenCalledWith("site_temp_pass", {
      kind: "site_temp_pass",
      sessionId: "session-1",
      hostname: "youtube.com",
      friendUserId: "user-b",
    });
    expect(result).toEqual({ ok: true, request: sampleRequest });
  });

  // v3.3 Task 11: the optional `message` field is forwarded through to createRequest unchanged.
  it("FRIEND_REQUEST_CREATE forwards an optional message to friendRequestApi.createRequest", async () => {
    const spy = vi
      .spyOn(friendRequestApi, "createRequest")
      .mockResolvedValue({ ...sampleRequest, message: "Need to check the syllabus" });

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CREATE",
      payload: {
        kind: "site_temp_pass",
        sessionId: "session-1",
        hostname: "youtube.com",
        friendUserId: "user-b",
        message: "Need to check the syllabus",
      },
    })) as { ok: boolean; request: FriendRequest };

    expect(spy).toHaveBeenCalledWith("site_temp_pass", {
      kind: "site_temp_pass",
      sessionId: "session-1",
      hostname: "youtube.com",
      friendUserId: "user-b",
      message: "Need to check the syllabus",
    });
    expect(result.request.message).toBe("Need to check the syllabus");
  });

  it("FRIEND_REQUEST_CREATE surfaces a thrown error as ok:false (outer handleMessage try/catch)", async () => {
    vi.spyOn(friendRequestApi, "createRequest").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CREATE",
      payload: {
        kind: "site_temp_pass",
        sessionId: "session-1",
        hostname: "youtube.com",
        friendUserId: "user-b",
      },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("FRIEND_REQUEST_APPROVE_TEMP_PASS routes to friendRequestApi.approveTempPass and returns ok:true with no code", async () => {
    const spy = vi
      .spyOn(friendRequestApi, "approveTempPass")
      .mockResolvedValue({ hostname: "youtube.com", expiresAt: 123 });

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_APPROVE_TEMP_PASS",
      payload: { requestId: "req-1" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("req-1");
    expect(result).toEqual({ ok: true, hostname: "youtube.com", expiresAt: 123 });
    expect(result).not.toHaveProperty("code");
  });

  it("FRIEND_REQUEST_APPROVE_TEMP_PASS surfaces a thrown error as ok:false", async () => {
    vi.spyOn(friendRequestApi, "approveTempPass").mockRejectedValue(
      new Error("Not authorized to approve this request")
    );

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_APPROVE_TEMP_PASS",
      payload: { requestId: "req-1" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not authorized to approve this request" });
  });

  // v3.4 Task 3, Decision 3: denial for site_temp_pass now goes through the shared
  // FRIEND_REQUEST_RESOLVE path (deny_temp_passcode_request() RPC is dropped) - the old
  // TEMP_PASSCODE_DENY-specific case no longer exists; FRIEND_REQUEST_RESOLVE's own coverage for
  // this (any kind) lives in messageRouterAccountability.test.ts.
  it("FRIEND_REQUEST_RESOLVE(denied) routes to friendRequestApi.resolveRequest for a site_temp_pass request too", async () => {
    const spy = vi.spyOn(friendRequestApi, "resolveRequest").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_RESOLVE",
      payload: { requestId: "req-1", decision: "denied" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("req-1", "denied");
    expect(result).toEqual({ ok: true });
  });

  it("FRIEND_REQUEST_CLAIM_TEMP_PASS routes to friendRequestApi.claimApproval and passes its result straight through", async () => {
    const spy = vi.spyOn(friendRequestApi, "claimApproval").mockResolvedValue({ ok: true });

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CLAIM_TEMP_PASS",
      payload: { requestId: "req-1" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("req-1");
    expect(result).toEqual({ ok: true });
  });

  it("FRIEND_REQUEST_CLAIM_TEMP_PASS passes through ok:false (claimApproval never throws, this is not the outer-catch path)", async () => {
    vi.spyOn(friendRequestApi, "claimApproval").mockResolvedValue({ ok: false });

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CLAIM_TEMP_PASS",
      payload: { requestId: "req-1" },
    })) as { ok: boolean };

    expect(result).toEqual({ ok: false });
  });

  it("FRIEND_REQUESTS_FETCH routes to friendRequestApi.fetchRelevantRequests", async () => {
    const spy = vi
      .spyOn(friendRequestApi, "fetchRelevantRequests")
      .mockResolvedValue([sampleRequest]);

    const result = (await handleMessage({
      type: "FRIEND_REQUESTS_FETCH",
      payload: { sinceTimestamp: 1000 },
    })) as { ok: boolean; requests: FriendRequest[] };

    expect(spy).toHaveBeenCalledWith(1000);
    expect(result).toEqual({ ok: true, requests: [sampleRequest] });
  });
});
