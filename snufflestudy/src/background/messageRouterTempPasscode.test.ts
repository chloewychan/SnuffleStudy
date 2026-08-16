// Covers messageRouter.ts's v2 Task 12 additions (TEMP_PASSCODE_* cases) in isolation, mirroring
// messageRouterAccountability.test.ts's own convention exactly: spies on tempPasscodeApi's
// exported functions (this repo's established test style) so these cases are verified to route
// to the right underlying call with the right arguments, entirely offline - no real network call
// is ever made, and no chrome.declarativeNetRequest/chrome.alarms side effect is exercised here
// (tempPasscodeApi.redeemCode's own unit tests, tempPasscodeApi.test.ts, already cover that).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import * as tempPasscodeApi from "../infrastructure/backend/tempPasscodeApi";
import type { TempPasscodeRequest } from "../domain/accountability/tempPasscodeRequest";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

const sampleRequest: TempPasscodeRequest = {
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
};

describe("messageRouter — TEMP_PASSCODE_*", () => {
  it("TEMP_PASSCODE_CREATE routes to tempPasscodeApi.createRequest with sessionId/hostname/friendUserId", async () => {
    const spy = vi.spyOn(tempPasscodeApi, "createRequest").mockResolvedValue(sampleRequest);

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_CREATE",
      payload: { sessionId: "session-1", hostname: "youtube.com", friendUserId: "user-b" },
    })) as { ok: boolean; request: TempPasscodeRequest };

    expect(spy).toHaveBeenCalledWith("session-1", "youtube.com", "user-b");
    expect(result).toEqual({ ok: true, request: sampleRequest });
  });

  it("TEMP_PASSCODE_CREATE surfaces a thrown error as ok:false (outer handleMessage try/catch)", async () => {
    vi.spyOn(tempPasscodeApi, "createRequest").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_CREATE",
      payload: { sessionId: "session-1", hostname: "youtube.com", friendUserId: "user-b" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("TEMP_PASSCODE_APPROVE routes to tempPasscodeApi.approveRequest and returns the plaintext code", async () => {
    const spy = vi.spyOn(tempPasscodeApi, "approveRequest").mockResolvedValue({ code: "483920" });

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_APPROVE",
      payload: { requestId: "req-1" },
    })) as { ok: boolean; code: string };

    expect(spy).toHaveBeenCalledWith("req-1");
    expect(result).toEqual({ ok: true, code: "483920" });
  });

  it("TEMP_PASSCODE_APPROVE surfaces a thrown error as ok:false", async () => {
    vi.spyOn(tempPasscodeApi, "approveRequest").mockRejectedValue(
      new Error("Not authorized to approve this request")
    );

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_APPROVE",
      payload: { requestId: "req-1" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not authorized to approve this request" });
  });

  it("TEMP_PASSCODE_DENY routes to tempPasscodeApi.denyRequest", async () => {
    const spy = vi.spyOn(tempPasscodeApi, "denyRequest").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_DENY",
      payload: { requestId: "req-1" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("req-1");
    expect(result).toEqual({ ok: true });
  });

  it("TEMP_PASSCODE_DENY surfaces a thrown error as ok:false", async () => {
    vi.spyOn(tempPasscodeApi, "denyRequest").mockRejectedValue(
      new Error("Could not deny this request — it may already have been resolved.")
    );

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_DENY",
      payload: { requestId: "req-1" },
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already have been resolved/);
  });

  it("TEMP_PASSCODE_REDEEM routes to tempPasscodeApi.redeemCode and passes its result straight through", async () => {
    const spy = vi.spyOn(tempPasscodeApi, "redeemCode").mockResolvedValue({ ok: true });

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_REDEEM",
      payload: { requestId: "req-1", code: "483920" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("req-1", "483920");
    expect(result).toEqual({ ok: true });
  });

  it("TEMP_PASSCODE_REDEEM passes through ok:false (redeemCode never throws, this is not the outer-catch path)", async () => {
    vi.spyOn(tempPasscodeApi, "redeemCode").mockResolvedValue({ ok: false });

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_REDEEM",
      payload: { requestId: "req-1", code: "000000" },
    })) as { ok: boolean };

    expect(result).toEqual({ ok: false });
  });

  it("TEMP_PASSCODE_REQUESTS_FETCH routes to tempPasscodeApi.fetchRelevantTempPasscodeRequests", async () => {
    const spy = vi
      .spyOn(tempPasscodeApi, "fetchRelevantTempPasscodeRequests")
      .mockResolvedValue([sampleRequest]);

    const result = (await handleMessage({
      type: "TEMP_PASSCODE_REQUESTS_FETCH",
      payload: { sinceTimestamp: 1000 },
    })) as { ok: boolean; requests: TempPasscodeRequest[] };

    expect(spy).toHaveBeenCalledWith(1000);
    expect(result).toEqual({ ok: true, requests: [sampleRequest] });
  });
});
