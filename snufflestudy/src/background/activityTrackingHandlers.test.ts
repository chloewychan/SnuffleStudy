import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  handleActivityTrackingStateChanged,
  registerActivityTrackingHandlers,
} from "./activityTrackingHandlers";
import { handleMessage } from "./messageRouter";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
import { stubFakeIdle } from "./testSupport/fakeIdle";
import type { CreateSessionInput } from "../domain/session/sessionTypes";
import type { UserSettings } from "../domain/settings/userSettings";

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

async function startFocusingSession(): Promise<string> {
  const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
    session: { id: string };
  };
  await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
  return created.session.id;
}

async function saveSettings(patch: Partial<UserSettings>): Promise<void> {
  const current = (await handleMessage({ type: "SETTINGS_GET" })) as { settings: UserSettings };
  await handleMessage({ type: "SETTINGS_SAVE", payload: { ...current.settings, ...patch } });
}

const historyRepo = new IndexedDbSessionRepository();

describe("handleActivityTrackingStateChanged", () => {
  it("records USER_WENT_IDLE for a FOCUSING session in activity-only mode with tracking enabled", async () => {
    const sessionId = await startFocusingSession();

    await handleActivityTrackingStateChanged("idle");

    const events = await historyRepo.listEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("USER_WENT_IDLE");
  });

  it("records USER_WENT_IDLE when the machine locks too", async () => {
    const sessionId = await startFocusingSession();

    await handleActivityTrackingStateChanged("locked");

    const events = await historyRepo.listEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("USER_WENT_IDLE");
  });

  it("records USER_RETURNED_FROM_IDLE on the transition back to active", async () => {
    const sessionId = await startFocusingSession();

    await handleActivityTrackingStateChanged("active");

    const events = await historyRepo.listEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("USER_RETURNED_FROM_IDLE");
  });

  it("does nothing when there is no active session", async () => {
    await expect(handleActivityTrackingStateChanged("idle")).resolves.toBeUndefined();
  });

  it("does nothing while a session is PAUSED, on a BREAK, or otherwise not FOCUSING", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await handleMessage({ type: "SESSION_PAUSE", payload: { sessionId: created.session.id } });

    await handleActivityTrackingStateChanged("idle");

    const events = await historyRepo.listEvents(created.session.id);
    expect(events).toHaveLength(0);
  });

  it("does nothing when tracking tier is detailed rather than activity-only", async () => {
    const sessionId = await startFocusingSession();
    await saveSettings({ trackingTier: "detailed" });

    await handleActivityTrackingStateChanged("idle");

    const events = await historyRepo.listEvents(sessionId);
    expect(events).toHaveLength(0);
  });

  it("does nothing when activityTrackingEnabled is toggled off, without touching prior history", async () => {
    const sessionId = await startFocusingSession();

    await handleActivityTrackingStateChanged("idle");
    await saveSettings({ activityTrackingEnabled: false });
    await handleActivityTrackingStateChanged("active");

    const events = await historyRepo.listEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("USER_WENT_IDLE");
  });
});

describe("registerActivityTrackingHandlers", () => {
  it("sets a 15-second detection interval and wires onStateChanged to record activity events", async () => {
    const fakeIdle = stubFakeIdle();
    const sessionId = await startFocusingSession();

    registerActivityTrackingHandlers();

    expect(fakeIdle.setDetectionInterval).toHaveBeenCalledWith(15);

    fakeIdle.__emit("idle");
    // handleActivityTrackingStateChanged is fired without awaiting inside the real listener,
    // and (unlike idleHandlers.ts's handler) it also awaits an IndexedDB open/write via
    // historyRepo.recordEvent - fake-indexeddb schedules its callbacks as real macrotasks, so
    // microtask-only flushing (a handful of `await Promise.resolve()`) isn't enough here. A
    // real setTimeout tick is.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = await historyRepo.listEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("USER_WENT_IDLE");
  });
});
