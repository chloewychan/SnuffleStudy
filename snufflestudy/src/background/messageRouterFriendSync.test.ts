// Covers messageRouter.ts's Task 6 additions: recordFriendStatusEvent wiring at v1's session
// lifecycle transition points, and the friend-poll alarm's start/stop wiring - kept separate
// from the main messageRouter.test.ts suite, mirroring messageRouterAccountability.test.ts's
// precedent for Task 5's own additions.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as sessionStatusSyncApi from "../infrastructure/backend/sessionStatusSyncApi";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { DEFAULT_USER_SETTINGS } from "../domain/settings/userSettings";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

const settingsRepo = new ChromeStorageRepository();

const createInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeDeclarativeNetRequest();
  indexedDB.deleteDatabase("snufflestudy");
  indexedDB.deleteDatabase("snufflestudy-tasks");
  vi.restoreAllMocks();
});

async function createAndStartSession(): Promise<string> {
  const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
    session: { id: string };
  };
  await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
  await tick();
  return created.session.id;
}

// recordFriendStatusEvent/maybeStartFriendPoll are fire-and-forget (see friendSync.ts /
// messageRouter.ts) - lets their promise chains settle before assertions.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mockSignedInWithNoGroups(userId = "user-a") {
  vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session: { user: { id: userId } } },
    error: null,
  } as never);
  // isInAnyGroup's group_memberships query - empty by default (no groups).
  vi.spyOn(supabase, "from").mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  } as never);
}

describe("messageRouter — recordFriendStatusEvent gating (signed-out / friend-sync-disabled pays zero network cost)", () => {
  it("does not touch Supabase auth at all when friendSyncEnabled is off (the default)", async () => {
    await settingsRepo.saveSettings(DEFAULT_USER_SETTINGS);
    const getSessionSpy = vi.spyOn(supabase.auth, "getSession");
    const fromSpy = vi.spyOn(supabase, "from");

    await createAndStartSession();

    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("does not call recordStatusEvent when friendSyncEnabled is on but signed out", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: null,
    } as never);
    const recordSpy = vi.spyOn(sessionStatusSyncApi, "recordStatusEvent");

    await createAndStartSession();

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("still completes SESSION_START successfully even if the friend-sync check throws", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    const result = (await handleMessage({
      type: "SESSION_START",
      payload: { sessionId: created.session.id },
    })) as { ok: boolean; session: { state: string } };

    expect(result.ok).toBe(true);
    expect(result.session.state).toBe("FOCUSING");
  });
});

describe("messageRouter — recordFriendStatusEvent wiring at each lifecycle transition (signed in + friend-sync enabled)", () => {
  beforeEach(async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    mockSignedInWithNoGroups();
  });

  it("SESSION_START records SESSION_STARTED with a generic displayLabel", async () => {
    const recordSpy = vi
      .spyOn(sessionStatusSyncApi, "recordStatusEvent")
      .mockResolvedValue(undefined);

    const sessionId = await createAndStartSession();

    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_STARTED",
      sessionId,
      displayLabel: "started a focus session",
    });
  });

  it("SESSION_PAUSE / SESSION_RESUME record SESSION_PAUSED / SESSION_RESUMED", async () => {
    const recordSpy = vi
      .spyOn(sessionStatusSyncApi, "recordStatusEvent")
      .mockResolvedValue(undefined);
    const sessionId = await createAndStartSession();

    await handleMessage({ type: "SESSION_PAUSE", payload: { sessionId } });
    await tick();
    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_PAUSED",
      sessionId,
      displayLabel: "paused their session",
    });

    await handleMessage({ type: "SESSION_RESUME", payload: { sessionId } });
    await tick();
    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_RESUMED",
      sessionId,
      displayLabel: "resumed their session",
    });
  });

  it("SESSION_START_BREAK / SESSION_END_BREAK record SESSION_BREAK_STARTED / SESSION_BREAK_ENDED", async () => {
    const recordSpy = vi
      .spyOn(sessionStatusSyncApi, "recordStatusEvent")
      .mockResolvedValue(undefined);
    const sessionId = await createAndStartSession();

    await handleMessage({ type: "SESSION_START_BREAK", payload: { sessionId } });
    await tick();
    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_BREAK_STARTED",
      sessionId,
      displayLabel: "took a break",
    });

    await handleMessage({ type: "SESSION_END_BREAK", payload: { sessionId } });
    await tick();
    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_BREAK_ENDED",
      sessionId,
      displayLabel: "ended their break",
    });
  });

  it("DISTRACTION_ATTEMPT records DISTRACTION_ATTEMPT with a generic displayLabel (never the hostname)", async () => {
    const recordSpy = vi
      .spyOn(sessionStatusSyncApi, "recordStatusEvent")
      .mockResolvedValue(undefined);
    const sessionId = await createAndStartSession();

    await handleMessage({
      type: "DISTRACTION_ATTEMPT",
      payload: { sessionId, hostname: "youtube.com" },
    });
    await tick();

    expect(recordSpy).toHaveBeenCalledWith({
      type: "DISTRACTION_ATTEMPT",
      sessionId,
      displayLabel: "got distracted",
    });
    // The privacy rule this call site is required to follow (session_status_events'
    // display_label column comment) - the hostname must never leak into the synced label.
    const call = recordSpy.mock.calls.find((c) => c[0].type === "DISTRACTION_ATTEMPT");
    expect(call?.[0].displayLabel).not.toContain("youtube.com");
  });

  it("SESSION_END (abandonment) records SESSION_ABANDONED and cancels the friend-poll alarm", async () => {
    const recordSpy = vi
      .spyOn(sessionStatusSyncApi, "recordStatusEvent")
      .mockResolvedValue(undefined);
    const sessionId = await createAndStartSession();

    await handleMessage({ type: "SESSION_END", payload: { sessionId } });
    await tick();

    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_ABANDONED",
      sessionId,
      displayLabel: "ended their session early",
    });
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();
  });
});

describe("messageRouter — friend-poll alarm start/stop wiring never touches the session-timer alarm", () => {
  it("SESSION_START does not start the friend-poll alarm when friendSyncEnabled is off", async () => {
    await settingsRepo.saveSettings(DEFAULT_USER_SETTINGS);

    await createAndStartSession();

    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeDefined();
  });

  it("SESSION_START does not start the friend-poll alarm when signed in + enabled but not in any group", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    mockSignedInWithNoGroups();

    await createAndStartSession();

    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeDefined();
  });

  it("SESSION_START starts the friend-poll alarm when signed in + enabled + in a group, alongside (not instead of) the session-timer alarm", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ group_id: "group-1" }], error: null }),
    } as never);

    await createAndStartSession();

    const friendPollAlarm = await chrome.alarms.get("snufflestudy-friend-poll");
    expect(friendPollAlarm).toBeDefined();
    expect(friendPollAlarm!.periodInMinutes).toBe(1);
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeDefined();
  });

  it("SESSION_PAUSE cancels the session-timer alarm but leaves an already-running friend-poll alarm untouched", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ group_id: "group-1" }], error: null }),
    } as never);
    const sessionId = await createAndStartSession();
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeDefined();

    await handleMessage({ type: "SESSION_PAUSE", payload: { sessionId } });

    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeUndefined();
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeDefined();
  });

  it("SESSION_DISMISS_COMPLETED/SESSION_DISMISS_ABANDONED clear the friend-poll alarm as a safety net", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ group_id: "group-1" }], error: null }),
    } as never);
    const sessionId = await createAndStartSession();

    await handleMessage({ type: "SESSION_END", payload: { sessionId } });
    await tick();
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();

    // Even though SESSION_END already cancelled it, dismissing must not error or resurrect it.
    const dismissed = (await handleMessage({
      type: "SESSION_DISMISS_ABANDONED",
      payload: { sessionId },
    })) as { ok: boolean };
    expect(dismissed.ok).toBe(true);
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();
  });
});

describe("messageRouter — FRIEND_EVENTS_FETCH", () => {
  it("routes to sessionStatusSyncApi.fetchNewEventsForFriends with the given sinceTimestamp", async () => {
    const events = [
      {
        id: "event-1",
        userId: "user-a",
        sessionId: "session-1",
        type: "SESSION_STARTED" as const,
        displayLabel: "started a focus session",
        occurredAt: 1_700_000_000_000,
      },
    ];
    const spy = vi.spyOn(sessionStatusSyncApi, "fetchNewEventsForFriends").mockResolvedValue(events);

    const result = (await handleMessage({
      type: "FRIEND_EVENTS_FETCH",
      payload: { sinceTimestamp: 1_699_999_000_000 },
    })) as { ok: boolean; events: typeof events };

    expect(spy).toHaveBeenCalledWith(1_699_999_000_000);
    expect(result).toEqual({ ok: true, events });
  });
});
