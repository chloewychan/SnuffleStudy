import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleTabUpdate } from "./tabHandlers";
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
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
};

describe("handleTabUpdate", () => {
  it("does nothing when the tracking tier is activity-only", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleTabUpdate(
      { status: "complete" },
      { url: "https://youtube.com/watch" } as chrome.tabs.Tab
    );

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number };
    };
    expect(active.session.distractionAttempts).toBe(0);
  });

  it("records a distraction attempt for a soft-restricted site when tracking is detailed", async () => {
    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: {
        pressureProfileId: "strict-coach",
        trackingTier: "detailed",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleTabUpdate(
      { status: "complete" },
      { url: "https://youtube.com/watch" } as chrome.tabs.Tab
    );

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number; interventionLevel: string };
    };
    expect(active.session.distractionAttempts).toBe(1);
    expect(active.session.interventionLevel).toBe("warned");
  });

  it("ignores an allowed site", async () => {
    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: {
        pressureProfileId: "strict-coach",
        trackingTier: "detailed",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, allowedSites: ["docs.google.com"] },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleTabUpdate(
      { status: "complete" },
      { url: "https://docs.google.com/doc/1" } as chrome.tabs.Tab
    );

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number };
    };
    expect(active.session.distractionAttempts).toBe(0);
  });

  it("records a distraction attempt using tab.url even when changeInfo (the real Chrome shape on the terminal event) carries no url at all", async () => {
    // Regression guard for the production bug this fix round closes: real Chrome only puts
    // `url` on the loading-phase changeInfo, never on the terminal {status:"complete"} delta -
    // the full current tab state (including url) is only in the third listener argument. A
    // handler that (incorrectly) read changeInfo.url instead would see undefined here and
    // silently no-op despite a real, classifiable navigation.
    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: {
        pressureProfileId: "strict-coach",
        trackingTier: "detailed",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    const changeInfo: chrome.tabs.OnUpdatedInfo = { status: "complete" };
    expect("url" in changeInfo).toBe(false);

    await handleTabUpdate(changeInfo, { url: "https://youtube.com/watch" } as chrome.tabs.Tab);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number; interventionLevel: string };
    };
    expect(active.session.distractionAttempts).toBe(1);
    expect(active.session.interventionLevel).toBe("warned");
  });
});
