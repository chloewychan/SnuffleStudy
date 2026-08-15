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
import * as nudgeApi from "../infrastructure/backend/nudgeApi";
import * as friendSync from "./friendSync";
import { getLastFriendPollAt, getLastNudgePollAt } from "../infrastructure/storage/friendPollState";
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

  // v2 Task 7: handleFriendPollAlarm now also polls nudges on every tick
  // (pollNudgeUpdates, alongside the pre-existing pollSessionEventUpdates). Defaulted to a
  // clean "no new nudges" result here so every pre-existing test in this describe block (which
  // only cares about the session-events half) never exercises nudgeApi's real
  // supabase.auth.getSession() call. The dedicated "nudge poll" tests further below override
  // this per-test.
  beforeEach(() => {
    vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });
  });

  // handleFriendPollAlarm now re-checks friend-sync eligibility on every tick (fix round 1) -
  // spying directly on friendSync.ts's exports (rather than settings+supabase, like the
  // natural-completion test further below does) keeps these tests focused on
  // handleFriendPollAlarm's own branching, independent of currentFriendSyncUserId/isInAnyGroup's
  // own implementation (covered separately by friendSync.test.ts).
  function mockFriendSyncEligible(userId = "user-a") {
    vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(userId);
    vi.spyOn(friendSync, "isInAnyGroup").mockResolvedValue(true);
  }

  it("dispatches the friend-poll alarm to pollNewEventsForFriends when eligible, without touching session state, and never falls through to the session-alarm branch", async () => {
    mockFriendSyncEligible();
    const pollSpy = vi
      .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
      .mockResolvedValue({ ok: true, events: [] });

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    expect(pollSpy).toHaveBeenCalledTimes(1);
    // No active session exists in this test - if the friend-poll branch fell through into the
    // session-alarm logic below it, getActiveSession()/completeSession() etc. would have to run
    // against a null session, which handleAlarm already guards against returning early on - so
    // this assertion is really just confirming pollNewEventsForFriends is the only thing that
    // ran.
    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).toBeNull();
  });

  it("shows a chrome.notifications toast for each new friend event, using its displayLabel", async () => {
    mockFriendSyncEligible();
    vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
      ok: true,
      events: [
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
      ],
    });
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

  it("persists the poll timestamp only on a successful poll, so a subsequent poll uses it as the new 'since' bound (survives a simulated service-worker restart)", async () => {
    mockFriendSyncEligible();
    const pollSpy = vi
      .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
      .mockResolvedValue({ ok: true, events: [] });
    expect(await getLastFriendPollAt()).toBeNull();

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    const persisted = await getLastFriendPollAt();
    expect(persisted).toEqual(expect.any(Number));

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    // Second call's "since" argument should be the timestamp persisted by the first call, not
    // some other fallback (e.g. the epoch, or a freshly-computed lookback window) - proving the
    // persisted cursor is actually read back, not just written.
    expect(pollSpy).toHaveBeenLastCalledWith(persisted);
  });

  // Fix round 1 (Important #1): a poll tick that fails must not advance the cursor - otherwise
  // any friend events that occurred during the outage are permanently lost, since the next tick
  // would start counting from `now` instead of retrying the failed window.
  it("does NOT advance the persisted cursor when the poll fails (ok: false), so the next tick retries the same window", async () => {
    mockFriendSyncEligible();
    const pollSpy = vi
      .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
      .mockResolvedValue({ ok: false, events: [] });

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
    expect(await getLastFriendPollAt()).toBeNull();

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
    expect(await getLastFriendPollAt()).toBeNull();

    // Both ticks queried with essentially the same fallback "since" (no persisted cursor ever
    // got written between them) - not asserting exact equality since Date.now() can tick forward
    // a millisecond between calls, just that neither call ever saw a persisted (non-fallback)
    // cursor.
    expect(pollSpy).toHaveBeenCalledTimes(2);
  });

  it("does not show any notifications when the poll fails", async () => {
    mockFriendSyncEligible();
    vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
      ok: false,
      events: [],
    });
    const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    expect(createNotificationSpy).not.toHaveBeenCalled();
  });

  // Fix round 1 (Important #2): the alarm's own start/stop points only evaluate eligibility once
  // (SESSION_START/end-of-session) - each recurring tick must independently re-confirm it's still
  // eligible, so toggling friendSyncEnabled off (or leaving the last group) mid-session actually
  // stops the polling work rather than continuing until the session ends regardless.
  it("skips the fetch entirely (no call to pollNewEventsForFriends) when friend-sync is no longer enabled/signed-in", async () => {
    vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(null);
    const pollSpy = vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends");

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    expect(pollSpy).not.toHaveBeenCalled();
  });

  it("skips the fetch entirely when the user is no longer in any group", async () => {
    vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue("user-a");
    vi.spyOn(friendSync, "isInAnyGroup").mockResolvedValue(false);
    const pollSpy = vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends");

    await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

    expect(pollSpy).not.toHaveBeenCalled();
  });

  it("still ignores an unrelated alarm name (the friend-poll branch does not swallow this case)", async () => {
    const pollSpy = vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends");

    await handleAlarm({ name: "some-other-alarm" } as chrome.alarms.Alarm);

    expect(pollSpy).not.toHaveBeenCalled();
  });

  describe("nudge polling (v2 Task 7 - reuses this same alarm, not a parallel one)", () => {
    it("dispatches to pollIncomingNudges when eligible, in the same tick as the session-events poll", async () => {
      mockFriendSyncEligible();
      const nudgePollSpy = vi
        .spyOn(nudgeApi, "pollIncomingNudges")
        .mockResolvedValue({ ok: true, nudges: [] });
      const eventPollSpy = vi
        .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
        .mockResolvedValue({ ok: true, events: [] });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(nudgePollSpy).toHaveBeenCalledTimes(1);
      expect(eventPollSpy).toHaveBeenCalledTimes(1);
    });

    it("shows a chrome.notifications toast for each new nudge, distinct in content from a session-event toast (message text + sender, not the generic 'Friend activity' copy)", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({
        ok: true,
        nudges: [
          {
            id: "nudge-1",
            senderUserId: "user-b",
            recipientUserId: "user-a",
            messageId: "keep-going",
            sentAt: Date.now(),
          },
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-nudge-nudge-1",
        expect.objectContaining({
          title: "Nudge from a friend",
          message: expect.stringContaining("Thinking of you"),
        })
      );
      const calls = createNotificationSpy.mock.calls as unknown as unknown[][];
      const call = calls.find((args) => args[0] === "friend-nudge-nudge-1");
      const options = call?.[1] as { title?: string; message?: string } | undefined;
      expect(options?.title).not.toBe("Friend activity");
      expect(options?.message).toContain("user-b");
    });

    it("persists the nudge-poll timestamp only on a successful poll, independently of the session-events cursor", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      const nudgePollSpy = vi
        .spyOn(nudgeApi, "pollIncomingNudges")
        .mockResolvedValue({ ok: true, nudges: [] });
      expect(await getLastNudgePollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      const persisted = await getLastNudgePollAt();
      expect(persisted).toEqual(expect.any(Number));

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(nudgePollSpy).toHaveBeenLastCalledWith(persisted);
    });

    // Mirrors Task 6 fix round 1's session-events guarantee: a failed nudge poll must not
    // advance the cursor, or nudges sent during the outage would be permanently lost once the
    // next tick starts counting from `now` instead of retrying the same window.
    it("does NOT advance the persisted nudge cursor when the nudge poll fails (ok: false), so the next tick retries the same window", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      const nudgePollSpy = vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: false });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastNudgePollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastNudgePollAt()).toBeNull();

      expect(nudgePollSpy).toHaveBeenCalledTimes(2);
    });

    it("a failed session-events poll does not prevent the nudge poll's cursor from advancing, and vice versa (the two streams are fully independent)", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: false,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(await getLastFriendPollAt()).toBeNull();
      expect(await getLastNudgePollAt()).toEqual(expect.any(Number));
    });

    it("does not show any nudge notifications when the nudge poll fails", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: false });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).not.toHaveBeenCalled();
    });

    it("skips the nudge fetch entirely when friend-sync is no longer enabled/signed-in (same eligibility gate as the session-events poll)", async () => {
      vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(null);
      const nudgePollSpy = vi.spyOn(nudgeApi, "pollIncomingNudges");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(nudgePollSpy).not.toHaveBeenCalled();
    });

    it("falls back to a generic message when a nudge's messageId isn't in the predefined catalog", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({
        ok: true,
        nudges: [
          {
            id: "nudge-2",
            senderUserId: "user-b",
            recipientUserId: "user-a",
            messageId: "some-future-message-id",
            sentAt: Date.now(),
          },
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-nudge-nudge-2",
        expect.objectContaining({ message: expect.stringContaining("sent you a nudge") })
      );
    });
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
