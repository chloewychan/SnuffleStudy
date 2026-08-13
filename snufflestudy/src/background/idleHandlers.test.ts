import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleIdleStateChanged, registerIdleHandlers } from "./idleHandlers";
import { handleMessage } from "./messageRouter";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
import { stubFakeIdle } from "./testSupport/fakeIdle";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeDeclarativeNetRequest();
  indexedDB.deleteDatabase("snufflestudy");
});

const createInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("handleIdleStateChanged", () => {
  it("updates activityState on the active FOCUSING session", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleIdleStateChanged("idle");

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { activityState: string };
    };
    expect(active.session.activityState).toBe("idle");
  });

  it("does nothing when there is no active session", async () => {
    await expect(handleIdleStateChanged("idle")).resolves.toBeUndefined();
  });

  it("does nothing while a session is PAUSED, on a BREAK, or otherwise not FOCUSING", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await handleMessage({ type: "SESSION_PAUSE", payload: { sessionId: created.session.id } });

    await handleIdleStateChanged("locked");

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { activityState: string };
    };
    expect(active.session.activityState).toBe("active");
  });
});

describe("registerIdleHandlers", () => {
  it("sets a 15-second detection interval and wires onStateChanged to handleIdleStateChanged", async () => {
    const fakeIdle = stubFakeIdle();

    registerIdleHandlers();

    expect(fakeIdle.setDetectionInterval).toHaveBeenCalledWith(15);
    expect(fakeIdle.onStateChanged.addListener).toHaveBeenCalledTimes(1);

    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    fakeIdle.__emit("active");
    // handleIdleStateChanged is fired without awaiting inside the real listener - flush
    // pending microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { activityState: string };
    };
    expect(active.session.activityState).toBe("active");
  });
});
