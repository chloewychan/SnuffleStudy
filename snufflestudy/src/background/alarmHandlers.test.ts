import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleAlarm } from "./alarmHandlers";
import { handleMessage } from "./messageRouter";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
import { IndexedDbTaskRepository } from "../infrastructure/storage/taskRepository";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { DEFAULT_USER_SETTINGS } from "../domain/settings/userSettings";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as sessionStatusSyncApi from "../infrastructure/backend/sessionStatusSyncApi";
import { getLastFriendPollAt } from "../infrastructure/storage/friendPollState";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeDeclarativeNetRequest();
  indexedDB.deleteDatabase("snufflestudy");
  indexedDB.deleteDatabase("snufflestudy-tasks");
  // Added alongside the friend-poll alarm tests below, which spy on the supabaseClient
  // singleton - restoring between tests keeps that isolated to the test that set it up rather
  // than leaking into later tests in this file (mirrors friendGroupApi.test.ts's/
  // messageRouterAccountability.test.ts's beforeEach convention).
  vi.restoreAllMocks();
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

describe("handleAlarm marks a linked task breakdown item's completedAt on natural completion", () => {
  // Fix round 1: this side effect moved here from messageRouter.ts's SESSION_END handler,
  // since that handler always represents an early/manual end (see its own comment) - a
  // breakdown item should only be marked done when its session completes naturally (this
  // file, timer-driven).
  it("marks the breakdown item complete when the naturally-completing session has a taskBreakdownItemId", async () => {
    const createdTask = (await handleMessage({
      type: "TASK_CREATE",
      payload: { title: "STAT231" },
    })) as { task: { id: string } };
    const withItem = (await handleMessage({
      type: "TASK_ADD_BREAKDOWN_ITEM",
      payload: { taskId: createdTask.task.id, description: "Chapter 6 of STAT231" },
    })) as { task: { breakdown: { id: string }[] } };
    const breakdownItemId = withItem.task.breakdown[0]!.id;

    const createdSession = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, goal: "Chapter 6 of STAT231", taskBreakdownItemId: breakdownItemId },
    })) as { session: { id: string; taskBreakdownItemId?: string } };
    expect(createdSession.session.taskBreakdownItemId).toBe(breakdownItemId);
    await handleMessage({ type: "SESSION_START", payload: { sessionId: createdSession.session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const listed = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { id: string; breakdown: { id: string; completedAt?: number }[] }[];
    };
    const item = listed.tasks
      .find((t) => t.id === createdTask.task.id)
      ?.breakdown.find((i) => i.id === breakdownItemId);
    expect(item?.completedAt).toEqual(expect.any(Number));
  });

  it("does not touch any task when the naturally-completing session has no taskBreakdownItemId", async () => {
    const createdTask = (await handleMessage({
      type: "TASK_CREATE",
      payload: { title: "STAT231" },
    })) as { task: { id: string } };
    const withItem = (await handleMessage({
      type: "TASK_ADD_BREAKDOWN_ITEM",
      payload: { taskId: createdTask.task.id, description: "Chapter 6 of STAT231" },
    })) as { task: { breakdown: { id: string }[] } };

    const createdSession = (await handleMessage({
      type: "SESSION_CREATE",
      payload: createInput,
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: createdSession.session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const listed = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { id: string; breakdown: { id: string; completedAt?: number }[] }[];
    };
    const item = listed.tasks
      .find((t) => t.id === createdTask.task.id)
      ?.breakdown.find((i) => i.id === withItem.task.breakdown[0]!.id);
    expect(item?.completedAt).toBeUndefined();
  });

  it("still archives, activates, and notifies even if marking the breakdown item complete throws", async () => {
    // The Task Vault side effect is wrapped in its own try/catch in alarmHandlers.ts - a
    // storage failure there must not prevent the session's own archival/active-session
    // update/notification, which have already succeeded by that point. Forces a genuine
    // throw (rather than the "no owning task found" no-op) by making the underlying
    // repository call reject.
    const listSpy = vi
      .spyOn(IndexedDbTaskRepository.prototype, "list")
      .mockRejectedValue(new Error("boom"));
    const createNotificationSpy = vi.spyOn(chrome.notifications, "create");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const createdSession = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, taskBreakdownItemId: "item_1" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: createdSession.session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    expect(listSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { state: string } | null;
    };
    expect(active.session?.state).toBe("COMPLETED");
    expect(createNotificationSpy).toHaveBeenCalledWith(
      "session-complete",
      expect.objectContaining({ title: "Goal complete" })
    );
  });
});

describe("handleAlarm — friend-poll alarm (v2 Task 6)", () => {
  const settingsRepo = new ChromeStorageRepository();

  it("dispatches the friend-poll alarm to fetchNewEventsForFriends without touching session state, and never falls through to the session-alarm branch", async () => {
    const fetchSpy = vi.spyOn(sessionStatusSyncApi, "fetchNewEventsForFriends").mockResolvedValue([]);

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // No active session exists in this test - if the friend-poll branch fell through into the
    // session-alarm logic below it, getActiveSession()/completeSession() etc. would have to run
    // against a null session, which handleAlarm already guards against returning early on - so
    // this assertion is really just confirming fetchNewEventsForFriends is the only thing that
    // ran.
    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).toBeNull();
  });

  it("shows a chrome.notifications toast for each new friend event, using its displayLabel", async () => {
    vi.spyOn(sessionStatusSyncApi, "fetchNewEventsForFriends").mockResolvedValue([
      {
        id: "event-1",
        userId: "user-a",
        sessionId: "session-1",
        type: "SESSION_STARTED",
        displayLabel: "started a focus session",
        occurredAt: Date.now(),
      },
      {
        id: "event-2",
        userId: "user-a",
        sessionId: "session-1",
        type: "DISTRACTION_ATTEMPT",
        displayLabel: "got distracted",
        occurredAt: Date.now(),
      },
    ]);
    const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    expect(createNotificationSpy).toHaveBeenCalledWith(
      "friend-event-event-1",
      expect.objectContaining({ message: "started a focus session" })
    );
    expect(createNotificationSpy).toHaveBeenCalledWith(
      "friend-event-event-2",
      expect.objectContaining({ message: "got distracted" })
    );
  });

  it("persists the poll timestamp so a subsequent poll uses it as the new 'since' bound (survives a simulated service-worker restart)", async () => {
    const fetchSpy = vi.spyOn(sessionStatusSyncApi, "fetchNewEventsForFriends").mockResolvedValue([]);
    expect(await getLastFriendPollAt()).toBeNull();

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    const persisted = await getLastFriendPollAt();
    expect(persisted).toEqual(expect.any(Number));

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    // Second call's "since" argument should be the timestamp persisted by the first call, not
    // some other fallback (e.g. the epoch, or a freshly-computed lookback window) - proving the
    // persisted cursor is actually read back, not just written.
    expect(fetchSpy).toHaveBeenLastCalledWith(persisted);
  });

  it("still ignores an unrelated alarm name (the friend-poll branch does not swallow this case)", async () => {
    const fetchSpy = vi.spyOn(sessionStatusSyncApi, "fetchNewEventsForFriends");

    await handleAlarm({ name: "some-other-alarm" } as chrome.alarms.Alarm);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cancels the friend-poll alarm and records a gated SESSION_COMPLETED event on natural completion", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);
    // messageRouter.ts's SESSION_START also evaluates whether to start the friend-poll alarm
    // (currentFriendSyncUserId + isInAnyGroup, from friendSync.ts) - isInAnyGroup queries
    // group_memberships directly against the supabase singleton, so it's stubbed here to look
    // like the user belongs to a group, letting SESSION_START's own wiring start the alarm
    // rather than needing a manual scheduleFriendPollAlarm() call to simulate it.
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ group_id: "group-1" }], error: null }),
    } as never);
    const recordSpy = vi
      .spyOn(sessionStatusSyncApi, "recordStatusEvent")
      .mockResolvedValue(undefined);

    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    // SESSION_START's friend-poll-alarm decision is fire-and-forget (see messageRouter.ts's
    // maybeStartFriendPoll) - give its promise chain a tick to resolve before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeDefined();

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();
    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_COMPLETED",
      sessionId: created.session.id,
      displayLabel: "completed a focus session",
    });
  });

  it("does not record SESSION_COMPLETED when friendSyncEnabled is off, but still completes the session normally", async () => {
    await settingsRepo.saveSettings(DEFAULT_USER_SETTINGS);
    const recordSpy = vi.spyOn(sessionStatusSyncApi, "recordStatusEvent");

    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recordSpy).not.toHaveBeenCalled();
    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { state: string };
    };
    expect(active.session.state).toBe("COMPLETED");
  });
});
