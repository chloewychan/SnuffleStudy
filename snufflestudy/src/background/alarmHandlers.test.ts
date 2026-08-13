import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleAlarm } from "./alarmHandlers";
import { handleMessage } from "./messageRouter";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
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

describe("handleAlarm", () => {
  it("auto-completes a FOCUSING session, archives it, and keeps it active in COMPLETED state for the UI to acknowledge", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { id: string; state: string } | null;
    };
    expect(active.session).not.toBeNull();
    expect(active.session!.state).toBe("COMPLETED");
    expect(active.session!.id).toBe(created.session.id);
  });

  it("ignores alarms that aren't the session alarm", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleAlarm({ name: "some-other-alarm" } as chrome.alarms.Alarm);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).not.toBeNull();
  });

  it("transitions a BREAK session back to FOCUSING", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    const { session } = (await handleMessage({
      type: "SESSION_START",
      payload: { sessionId: created.session.id },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START_BREAK", payload: { sessionId: session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { state: string };
    };
    expect(active.session.state).toBe("FOCUSING");
  });

  it("clears hard-block DNR rules when a hard-mode session auto-completes via the alarm", async () => {
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "hard" },
    })) as { session: { id: string } };

    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    // SESSION_START's syncHardBlockRules should have installed a redirect rule.
    const rulesAfterStart = await chrome.declarativeNetRequest.getDynamicRules();
    expect(rulesAfterStart.length).toBeGreaterThan(0);

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const rulesAfterComplete = await chrome.declarativeNetRequest.getDynamicRules();
    expect(rulesAfterComplete).toEqual([]);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { state: string } | null;
    };
    expect(active.session).not.toBeNull();
    expect(active.session!.state).toBe("COMPLETED");
  });
});
