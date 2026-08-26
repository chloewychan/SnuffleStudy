import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleTabUpdate } from "./tabHandlers";
import { handleMessage } from "./messageRouter";
import { handleAlarm } from "./alarmHandlers";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
import * as friendSync from "./friendSync";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as sessionStatusSyncApi from "../infrastructure/backend/sessionStatusSyncApi";
import * as nudgeApi from "../infrastructure/backend/nudgeApi";
import * as unlockRequestApi from "../infrastructure/backend/unlockRequestApi";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeDeclarativeNetRequest();
  indexedDB.deleteDatabase("snufflestudy");
  // Added alongside the v2 Task 8 unlock-request test below, which spies on friendSync.ts's/
  // sessionStatusSyncApi's/nudgeApi's/unlockRequestApi's exports - restoring between tests keeps
  // that isolated rather than leaking into other tests in this file (mirrors
  // alarmHandlers.test.ts's identical beforeEach convention).
  vi.restoreAllMocks();
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
        activityTrackingEnabled: true,
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
        friendSyncEnabled: false,
        liveNudgesNotificationsEnabled: true,
        digestNotificationsEnabled: true,
        quietHours: null,
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
        activityTrackingEnabled: true,
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
        friendSyncEnabled: false,
        liveNudgesNotificationsEnabled: true,
        digestNotificationsEnabled: true,
        quietHours: null,
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
        activityTrackingEnabled: true,
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
        friendSyncEnabled: false,
        liveNudgesNotificationsEnabled: true,
        digestNotificationsEnabled: true,
        quietHours: null,
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

  // v2 Task 8, Definition of Done: "a soft-restricted site, once an unlock request is approved
  // by a friend, becomes accessible without a distraction warning for the rest of the session."
  // This is the actual DoD-critical assertion end-to-end, entirely at the domain/integration
  // level - no live database needed: an approved unlock request (delivered via
  // alarmHandlers.ts's friend-poll alarm, mocked here at the unlockRequestApi boundary, same as
  // alarmHandlers.test.ts's own unlock-request-polling tests) merges the hostname into the
  // active session's allowedSites, and THEN a real navigation to that exact hostname must not
  // record a distraction attempt or escalate interventionLevel - proving tabHandlers.ts's
  // warning path (classifySite(...) !== "BLOCKED" -> early return, see that file) never
  // triggers for it, without needing siteRestrictionOverrides (which this task deliberately does
  // not use - see this task's report for why).
  it("v2 Task 8: a site approved via an unlock request stops triggering the distraction/warning path for the rest of the session", async () => {
    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: {
        pressureProfileId: "strict-coach",
        trackingTier: "detailed",
        activityTrackingEnabled: true,
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
        friendSyncEnabled: false,
        liveNudgesNotificationsEnabled: true,
        digestNotificationsEnabled: true,
        quietHours: null,
      },
    });
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "soft" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    // Sanity check: before any unlock request, youtube.com is soft-restricted and DOES trigger
    // the warning path (same as the "records a distraction attempt..." test above).
    await handleTabUpdate(
      { status: "complete" },
      { url: "https://youtube.com/watch" } as chrome.tabs.Tab
    );
    const beforeApproval = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number };
    };
    expect(beforeApproval.session.distractionAttempts).toBe(1);

    // Simulate a friend approving an unlock request for this exact session/hostname, delivered
    // via the friend-poll alarm - same mechanism/mocking boundary as
    // alarmHandlers.test.ts's "notifies with distinct copy when the current user's own request
    // was approved..." test.
    vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue("user-a");
    vi.spyOn(friendSync, "hasAnyFriend").mockResolvedValue(true);
    // v3.4 Task 2: pollFriendConnectionUpdates (alarmHandlers.ts's 8th stream) queries the
    // supabase singleton directly (no dedicated *Api.ts module) - stubbed here so this test's
    // real handleAlarm() call below doesn't make a genuine, unmocked network request for that one
    // stream (every OTHER stream here is already mocked via its own *Api.ts spy).
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as never);
    vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
      ok: true,
      events: [],
    });
    vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });
    vi.spyOn(unlockRequestApi, "pollRelevantUnlockRequests").mockResolvedValue({
      ok: true,
      requests: [
        {
          id: "req-1",
          sessionId: created.session.id,
          requesterUserId: "user-a",
          hostname: "youtube.com",
          status: "approved",
          requestedAt: Date.now(),
          resolvedAt: Date.now(),
          resolvedBy: "user-b",
        },
      ],
    });

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    // classifySite must now report ALLOWED for this hostname on this session.
    const afterApproval = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { id: string; allowedSites: string[]; distractionAttempts: number };
    };
    expect(afterApproval.session.allowedSites).toContain("youtube.com");

    // The actual DoD assertion: a fresh navigation to the now-approved hostname must NOT record
    // another distraction attempt (distractionAttempts stays at 1, from before the approval) -
    // proving tabHandlers.ts's warning path never re-triggers for it.
    await handleTabUpdate(
      { status: "complete" },
      { url: "https://youtube.com/watch?v=2" } as chrome.tabs.Tab
    );
    const afterNavigation = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number };
    };
    expect(afterNavigation.session.distractionAttempts).toBe(1);
  });
});
