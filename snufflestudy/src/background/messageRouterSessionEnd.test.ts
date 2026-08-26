// Covers messageRouter.ts's v3.3 Task 12 additions (originally SESSION_END_REQUEST_* thin
// pass-throughs, v3.4 Task 3: consolidated into FRIEND_REQUEST_*, exercised here with
// kind: "session_end" - site_unlock coverage lives in messageRouterAccountability.test.ts,
// site_temp_pass in messageRouterTempPasscode.test.ts, retargeted the same way) in isolation,
// mirroring messageRouterTempPasscode.test.ts's own convention exactly: spies on
// friendRequestApi's exported functions (this repo's established test style) so these cases are
// verified to route to the right underlying call with the right arguments, entirely offline.
// SESSION_END's own endRequestId branch (the security-critical half of this task) is covered
// separately in messageRouter.test.ts's "SESSION_END hard-block enforcement" describe block,
// alongside the pre-existing passcode-path tests it must not disturb.
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
  id: "end-req-1",
  kind: "session_end",
  sessionId: "session-1",
  requesterUserId: "user-a",
  friendUserId: "user-b",
  message: null,
  hostname: null,
  status: "pending",
  requestedAt: 0,
  resolvedAt: null,
  resolvedBy: null,
  expiresAt: null,
};

describe("messageRouter — FRIEND_REQUEST_* (session_end)", () => {
  it("FRIEND_REQUEST_CREATE routes to friendRequestApi.createRequest with kind/sessionId/friendUserId", async () => {
    const spy = vi.spyOn(friendRequestApi, "createRequest").mockResolvedValue(sampleRequest);

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CREATE",
      payload: { kind: "session_end", sessionId: "session-1", friendUserId: "user-b" },
    })) as { ok: boolean; request: FriendRequest };

    expect(spy).toHaveBeenCalledWith("session_end", {
      kind: "session_end",
      sessionId: "session-1",
      friendUserId: "user-b",
    });
    expect(result).toEqual({ ok: true, request: sampleRequest });
  });

  it("FRIEND_REQUEST_CREATE surfaces a thrown error as ok:false (outer handleMessage try/catch)", async () => {
    vi.spyOn(friendRequestApi, "createRequest").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CREATE",
      payload: { kind: "session_end", sessionId: "session-1", friendUserId: "user-b" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("FRIEND_REQUEST_RESOLVE routes to friendRequestApi.resolveRequest with requestId/decision", async () => {
    const spy = vi.spyOn(friendRequestApi, "resolveRequest").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_RESOLVE",
      payload: { requestId: "end-req-1", decision: "approved" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("end-req-1", "approved");
    expect(result).toEqual({ ok: true });
  });

  it("FRIEND_REQUEST_RESOLVE surfaces a thrown error as ok:false (e.g. first-responder-wins race)", async () => {
    vi.spyOn(friendRequestApi, "resolveRequest").mockRejectedValue(
      new Error("Could not resolve this request — it may already have been resolved.")
    );

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_RESOLVE",
      payload: { requestId: "end-req-1", decision: "denied" },
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already have been resolved/);
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
