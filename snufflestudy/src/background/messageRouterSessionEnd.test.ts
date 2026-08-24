// Covers messageRouter.ts's v3.3 Task 12 additions (SESSION_END_REQUEST_* thin pass-throughs) in
// isolation, mirroring messageRouterTempPasscode.test.ts's own convention exactly: spies on
// sessionEndRequestApi's exported functions (this repo's established test style) so these cases
// are verified to route to the right underlying call with the right arguments, entirely offline.
// SESSION_END's own endRequestId branch (the security-critical half of this task) is covered
// separately in messageRouter.test.ts's "SESSION_END hard-block enforcement" describe block,
// alongside the pre-existing passcode-path tests it must not disturb.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import * as sessionEndRequestApi from "../infrastructure/backend/sessionEndRequestApi";
import type { SessionEndRequest } from "../domain/accountability/sessionEndRequest";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

const sampleRequest: SessionEndRequest = {
  id: "end-req-1",
  sessionId: "session-1",
  requesterUserId: "user-a",
  status: "pending",
  requestedAt: 0,
  resolvedAt: null,
  resolvedBy: null,
};

describe("messageRouter — SESSION_END_REQUEST_*", () => {
  it("SESSION_END_REQUEST_CREATE routes to sessionEndRequestApi.createRequest with sessionId", async () => {
    const spy = vi.spyOn(sessionEndRequestApi, "createRequest").mockResolvedValue(sampleRequest);

    const result = (await handleMessage({
      type: "SESSION_END_REQUEST_CREATE",
      payload: { sessionId: "session-1" },
    })) as { ok: boolean; request: SessionEndRequest };

    expect(spy).toHaveBeenCalledWith("session-1");
    expect(result).toEqual({ ok: true, request: sampleRequest });
  });

  it("SESSION_END_REQUEST_CREATE surfaces a thrown error as ok:false (outer handleMessage try/catch)", async () => {
    vi.spyOn(sessionEndRequestApi, "createRequest").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "SESSION_END_REQUEST_CREATE",
      payload: { sessionId: "session-1" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("SESSION_END_REQUEST_RESOLVE routes to sessionEndRequestApi.resolveRequest with requestId/decision", async () => {
    const spy = vi.spyOn(sessionEndRequestApi, "resolveRequest").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "SESSION_END_REQUEST_RESOLVE",
      payload: { requestId: "end-req-1", decision: "approved" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("end-req-1", "approved");
    expect(result).toEqual({ ok: true });
  });

  it("SESSION_END_REQUEST_RESOLVE surfaces a thrown error as ok:false (e.g. first-responder-wins race)", async () => {
    vi.spyOn(sessionEndRequestApi, "resolveRequest").mockRejectedValue(
      new Error("Could not resolve this request — it may already have been resolved.")
    );

    const result = (await handleMessage({
      type: "SESSION_END_REQUEST_RESOLVE",
      payload: { requestId: "end-req-1", decision: "denied" },
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already have been resolved/);
  });

  it("SESSION_END_REQUESTS_FETCH routes to sessionEndRequestApi.fetchRelevantSessionEndRequests", async () => {
    const spy = vi
      .spyOn(sessionEndRequestApi, "fetchRelevantSessionEndRequests")
      .mockResolvedValue([sampleRequest]);

    const result = (await handleMessage({
      type: "SESSION_END_REQUESTS_FETCH",
      payload: { sinceTimestamp: 1000 },
    })) as { ok: boolean; requests: SessionEndRequest[] };

    expect(spy).toHaveBeenCalledWith(1000);
    expect(result).toEqual({ ok: true, requests: [sampleRequest] });
  });
});
