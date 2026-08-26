import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import * as friendRequestApi from "../infrastructure/backend/friendRequestApi";
import type { FriendRequest } from "../domain/accountability/friendRequest";
import * as digestApi from "../infrastructure/backend/digestApi";
import type { FriendDigest } from "../infrastructure/backend/digestApi";
import * as declarativeNetRequestApi from "../infrastructure/browser/declarativeNetRequestApi";
import * as producerTagApi from "../infrastructure/backend/producerTagApi";
import type { IncomingProducerTag } from "../infrastructure/backend/producerTagApi";
import * as profileApi from "../infrastructure/backend/profileApi";
import * as friendSync from "./friendSync";
import {
  getLastFriendPollAt,
  getLastNudgePollAt,
  getLastFriendRequestPollAt,
  getLastDigestPollAt,
  getLastProducerTagPollAt,
  getLastFriendConnectionPollAt,
} from "../infrastructure/storage/friendPollState";
import { classifySite } from "../domain/sites/siteRules";
import type { CreateSessionInput, StudySession } from "../domain/session/sessionTypes";

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

afterEach(() => {
  // Guards the two quiet-hours tests below, which use vi.useFakeTimers()/setSystemTime() -
  // always restore even on failure so real timers never leak into a later test in this file.
  vi.useRealTimers();
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
      .spyOn(IndexedDbTaskRepository.prototype, "listAll")
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
  //
  // v3.4 Task 3: same treatment for the third stream, the consolidated friend-request poll
  // (pollFriendRequestUpdates - replaces the three separate unlock-request/temp-passcode-request/
  // session-end-request spies this task retires, now that all three kinds are one friend_requests
  // table behind one pollRelevantRequests query) - defaulted to a clean "no new/resolved
  // requests" result for the identical reason. The dedicated "friend-request polling" tests
  // further below override this per-test.
  //
  // v2 Task 9: same treatment for the fourth stream, daily digests (pollDigestUpdates) -
  // defaulted to a clean "no new digests" result so every pre-existing test in this describe
  // block (which predates Task 9) never exercises digestApi's real supabase.auth.getSession()
  // call. The dedicated "digest poll" tests further below override this per-test.
  beforeEach(() => {
    vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });
    vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
      ok: true,
      requests: [],
    });
    vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({ ok: true, digests: [] });
    // v2 Task 14: same treatment for the fifth stream, producer tags (pollProducerTagUpdates) -
    // defaulted to a clean "no new tags" result so every pre-existing test in this describe block
    // (which predates Task 14) never exercises producerTagApi's real supabase.auth.getSession()
    // call. The dedicated "producer tag polling" tests further below override this per-test.
    vi.spyOn(producerTagApi, "pollIncomingProducerTagSends").mockResolvedValue({
      ok: true,
      sends: [],
    });
    // v3.4 Task 2: same treatment for the sixth stream, new friend connections
    // (pollFriendConnectionUpdates) - this one queries the supabase singleton directly (no
    // dedicated *Api.ts module - see alarmHandlers.ts's own comment on why), so it's stubbed via
    // supabase.from rather than vi.spyOn on an Api export, defaulted to "no new connections" so
    // every pre-existing test in this describe block (which predates Task 2) never exercises a
    // real network call. The dedicated "friend connection polling" tests further below override
    // this per-test.
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as never);
  });

  // handleFriendPollAlarm now re-checks friend-sync eligibility on every tick (fix round 1) -
  // spying directly on friendSync.ts's exports (rather than settings+supabase, like the
  // natural-completion test further below does) keeps these tests focused on
  // handleFriendPollAlarm's own branching, independent of currentFriendSyncUserId/hasAnyFriend's
  // own implementation (covered separately by friendSync.test.ts).
  function mockFriendSyncEligible(userId = "user-a") {
    vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(userId);
    vi.spyOn(friendSync, "hasAnyFriend").mockResolvedValue(true);
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

  it("skips the fetch entirely when the user has no friends", async () => {
    vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue("user-a");
    vi.spyOn(friendSync, "hasAnyFriend").mockResolvedValue(false);
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

    describe("v2 Task 10 Part C: local notification-preference gating (does not affect the fetch/cursor)", () => {
      function sampleNudge() {
        return {
          id: "nudge-3",
          senderUserId: "user-b",
          recipientUserId: "user-a",
          messageId: "keep-going",
          sentAt: Date.now(),
        };
      }

      it("suppresses the nudge toast when liveNudgesNotificationsEnabled is false, but still advances the cursor", async () => {
        await settingsRepo.saveSettings({
          ...DEFAULT_USER_SETTINGS,
          liveNudgesNotificationsEnabled: false,
        });
        mockFriendSyncEligible();
        vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
          ok: true,
          events: [],
        });
        vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({
          ok: true,
          nudges: [sampleNudge()],
        });
        const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

        await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

        expect(createNotificationSpy).not.toHaveBeenCalled();
        expect(await getLastNudgePollAt()).toEqual(expect.any(Number));
      });

      it("suppresses the nudge toast during configured quiet hours, but still advances the cursor", async () => {
        // Pins the system clock to a fixed noon timestamp rather than relying on the real
        // wall-clock hour falling inside [0, 23) - the original same-day-window approach was
        // "vanishingly unlikely" to flake but genuinely did, whenever this suite happened to run
        // during hour 23 local time. vi.useRealTimers() runs in this file's top-level afterEach.
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T12:00:00"));

        await settingsRepo.saveSettings({
          ...DEFAULT_USER_SETTINGS,
          quietHours: { startHour: 0, endHour: 23 },
        });
        mockFriendSyncEligible();
        vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
          ok: true,
          events: [],
        });
        vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({
          ok: true,
          nudges: [sampleNudge()],
        });
        const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

        await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

        expect(createNotificationSpy).not.toHaveBeenCalled();
        expect(await getLastNudgePollAt()).toEqual(expect.any(Number));
      });

      it("still shows the nudge toast when notifications are enabled and no quiet hours are configured (unaffected by this task)", async () => {
        await settingsRepo.saveSettings(DEFAULT_USER_SETTINGS);
        mockFriendSyncEligible();
        vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
          ok: true,
          events: [],
        });
        vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({
          ok: true,
          nudges: [sampleNudge()],
        });
        const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

        await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

        expect(createNotificationSpy).toHaveBeenCalledWith(
          "friend-nudge-nudge-3",
          expect.objectContaining({ title: "Nudge from a friend" })
        );
      });
    });
  });

  // v3.4 Task 3: replaces the three separate "unlock-request polling"/"temp passcode request
  // polling"/"session-end request polling" describe blocks (v2 Task 8/Task 12/v3.3 Task 12) with
  // one - unlock_requests/temp_passcode_requests/session_end_requests are now one friend_requests
  // table behind one pollFriendRequestUpdates function/one pollRelevantRequests query, exercised
  // here with all three kind values. site_unlock's approved case auto-applies the hostname to the
  // requester's own active session's allowedSites (mirrors the old unlock-request block's own
  // coverage); site_temp_pass's approved case unlocks the real DNR rule (mirrors the old temp
  // passcode block's own coverage); session_end's approved case deliberately does NOT touch the
  // active session at all (mirrors the old session-end block's own coverage of that asymmetry -
  // see the Global Constraints note: ending a session is disruptive, so it's never auto-applied
  // from this background poll).
  describe("friend-request polling (v3.4 Task 3 - reuses this same alarm, not a parallel one)", () => {
    function sampleRequest(overrides: Partial<FriendRequest> = {}): FriendRequest {
      return {
        id: "req-1",
        kind: "site_unlock",
        sessionId: "session-1",
        requesterUserId: "user-b",
        friendUserId: null,
        message: null,
        hostname: "youtube.com",
        status: "pending",
        requestedAt: Date.now(),
        resolvedAt: null,
        resolvedBy: null,
        expiresAt: null,
        ...overrides,
      };
    }

    it("dispatches to pollRelevantRequests when eligible, in the same tick as the other two streams", async () => {
      mockFriendSyncEligible();
      const friendRequestPollSpy = vi
        .spyOn(friendRequestApi, "pollRelevantRequests")
        .mockResolvedValue({ ok: true, requests: [] });
      const eventPollSpy = vi
        .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
        .mockResolvedValue({ ok: true, events: [] });
      const nudgePollSpy = vi
        .spyOn(nudgeApi, "pollIncomingNudges")
        .mockResolvedValue({ ok: true, nudges: [] });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(friendRequestPollSpy).toHaveBeenCalledTimes(1);
      expect(eventPollSpy).toHaveBeenCalledTimes(1);
      expect(nudgePollSpy).toHaveBeenCalledTimes(1);
    });

    it("shows a chrome.notifications toast when a friend (someone else) has a new pending site_unlock request", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [sampleRequest({ requesterUserId: "user-b", status: "pending" })],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-pending-req-1",
        expect.objectContaining({
          title: "Friend request",
          message: expect.stringContaining("youtube.com"),
        })
      );
    });

    it("does NOT notify about the current user's own still-pending request (they already know they just created it)", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [sampleRequest({ requesterUserId: "user-a", status: "pending" })],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).not.toHaveBeenCalled();
    });

    it("site_unlock: notifies with distinct copy when the current user's own request was approved, and merges the hostname into the active session's allowedSites", async () => {
      mockFriendSyncEligible("user-a");
      const created = (await handleMessage({
        type: "SESSION_CREATE",
        payload: { ...createInput, restrictedSites: ["youtube.com"] },
      })) as { session: { id: string } };
      await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            sessionId: created.session.id,
            requesterUserId: "user-a",
            status: "approved",
            resolvedBy: "user-b",
          }),
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-req-1",
        expect.objectContaining({
          title: "Unlock request approved",
          message: expect.stringContaining("youtube.com"),
        })
      );

      const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
        session: { allowedSites: string[] };
      };
      expect(active.session.allowedSites).toContain("youtube.com");

      // The DoD-critical assertion (per v2 Task 8's original brief, preserved by this
      // consolidation): classifySite must now return ALLOWED for the unlocked hostname on this
      // session - this is the actual mechanism that makes tabHandlers.ts's warning path never
      // trigger for it (see that file's early return on anything classifySite doesn't call
      // BLOCKED), independent of siteRestrictionOverrides (which this task deliberately does not
      // use).
      const activeSession = (
        (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: StudySession }
      ).session;
      expect(classifySite(activeSession, "youtube.com")).toBe("ALLOWED");
    });

    it("site_unlock: notifies with distinct copy when the current user's own request was denied, and does NOT touch allowedSites", async () => {
      mockFriendSyncEligible("user-a");
      const created = (await handleMessage({
        type: "SESSION_CREATE",
        payload: { ...createInput, restrictedSites: ["youtube.com"] },
      })) as { session: { id: string } };
      await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            sessionId: created.session.id,
            requesterUserId: "user-a",
            status: "denied",
            resolvedBy: "user-b",
          }),
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-req-1",
        expect.objectContaining({
          title: "Request denied",
          message: expect.stringContaining("youtube.com"),
        })
      );

      const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
        session: { allowedSites: string[] };
      };
      expect(active.session.allowedSites).not.toContain("youtube.com");
    });

    it("site_unlock: does NOT apply the allowedSites merge when the approval's sessionId no longer matches the active session (stale approval guard)", async () => {
      mockFriendSyncEligible("user-a");
      const created = (await handleMessage({
        type: "SESSION_CREATE",
        payload: { ...createInput, restrictedSites: ["youtube.com"] },
      })) as { session: { id: string } };
      await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            sessionId: "some-other-stale-session-id",
            requesterUserId: "user-a",
            status: "approved",
            resolvedBy: "user-b",
          }),
        ],
      });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
        session: { allowedSites: string[] };
      };
      expect(active.session.allowedSites).not.toContain("youtube.com");
    });

    it("site_unlock: does NOT apply the allowedSites merge when there is no active session at all", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            sessionId: "session-1",
            requesterUserId: "user-a",
            status: "approved",
            resolvedBy: "user-b",
          }),
        ],
      });

      // Should not throw even though getActiveSession() returns null.
      await expect(
        handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm)
      ).resolves.not.toThrow();

      const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
      expect(active.session).toBeNull();
    });

    it("site_temp_pass: unlocks the hostname's real DNR rule when the requester's own request was approved", async () => {
      const created = (await handleMessage({
        type: "SESSION_CREATE",
        payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "hard" },
      })) as { session: { id: string } };
      await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
      const rulesBefore = await chrome.declarativeNetRequest.getDynamicRules();
      expect(
        rulesBefore.some((rule) => rule.condition.requestDomains?.includes("youtube.com"))
      ).toBe(true);

      mockFriendSyncEligible("user-a");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            kind: "site_temp_pass",
            requesterUserId: "user-a",
            status: "approved",
            hostname: "youtube.com",
            expiresAt: Date.now() + 15 * 60 * 1000,
          }),
        ],
      });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      const rulesAfter = await chrome.declarativeNetRequest.getDynamicRules();
      expect(
        rulesAfter.some((rule) => rule.condition.requestDomains?.includes("youtube.com"))
      ).toBe(false);
    });

    // A failure applying an approved site_temp_pass (e.g. the DNR API itself unavailable) must
    // not prevent the notification from still firing - mirrors site_unlock's own
    // best-effort-then-notify-anyway posture.
    it("site_temp_pass: still sends the approval notification even if applying the unlock throws", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            kind: "site_temp_pass",
            requesterUserId: "user-a",
            status: "approved",
            hostname: "youtube.com",
          }),
        ],
      });
      vi.spyOn(declarativeNetRequestApi, "unlockHardBlockRuleForHostname").mockRejectedValue(
        new Error("DNR API unavailable")
      );
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-req-1",
        expect.objectContaining({ title: "Temporary passcode approved" })
      );
    });

    it("site_temp_pass: notifies the requester when their own request was denied", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({ kind: "site_temp_pass", requesterUserId: "user-a", status: "denied" }),
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-req-1",
        expect.objectContaining({ title: "Request denied" })
      );
    });

    it("site_temp_pass: notifies the assigned friend about a new pending request from someone else", async () => {
      mockFriendSyncEligible("user-b");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            kind: "site_temp_pass",
            requesterUserId: "user-a",
            friendUserId: "user-b",
            status: "pending",
          }),
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-pending-req-1",
        expect.objectContaining({ title: "Friend request" })
      );
    });

    it("session_end: notifies with distinct copy when the current user's own request was approved, and does NOT touch the active session (no auto-apply, per the Global Constraints note)", async () => {
      mockFriendSyncEligible("user-a");
      const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
        session: { id: string };
      };
      await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            kind: "session_end",
            sessionId: created.session.id,
            requesterUserId: "user-a",
            hostname: null,
            status: "approved",
            resolvedBy: "user-b",
          }),
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-req-1",
        expect.objectContaining({ title: "Temporary pass approved" })
      );

      // The DoD-critical negative-of-a-different-kind: unlike site_unlock's approved case (which
      // DOES mutate allowedSites), this must never end, abandon, or otherwise mutate the session
      // on its own - the session is still exactly where it was, still FOCUSING.
      const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
        session: { id: string; state: string };
      };
      expect(active.session.id).toBe(created.session.id);
      expect(active.session.state).toBe("FOCUSING");
    });

    it("session_end: notifies with distinct copy when the current user's own request was denied", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [
          sampleRequest({
            kind: "session_end",
            hostname: null,
            requesterUserId: "user-a",
            status: "denied",
            resolvedBy: "user-b",
          }),
        ],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-request-req-1",
        expect.objectContaining({ title: "Request denied" })
      );
    });

    it("persists the friend-request-poll timestamp only on a successful poll, independently of the other two cursors", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });
      const friendRequestPollSpy = vi
        .spyOn(friendRequestApi, "pollRelevantRequests")
        .mockResolvedValue({ ok: true, requests: [] });
      expect(await getLastFriendRequestPollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      const persisted = await getLastFriendRequestPollAt();
      expect(persisted).toEqual(expect.any(Number));

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(friendRequestPollSpy).toHaveBeenLastCalledWith(persisted);
    });

    // Mirrors Task 6 fix round 1's session-events guarantee (and Task 7's identical nudge
    // guarantee): a failed friend-request poll must not advance the cursor, or a pending
    // request/resolution that arrived during the outage would be permanently lost once the next
    // tick starts counting from `now` instead of retrying the same window.
    it("does NOT advance the persisted friend-request cursor when the poll fails (ok: false), so the next tick retries the same window", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });
      const friendRequestPollSpy = vi
        .spyOn(friendRequestApi, "pollRelevantRequests")
        .mockResolvedValue({ ok: false });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastFriendRequestPollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastFriendRequestPollAt()).toBeNull();

      expect(friendRequestPollSpy).toHaveBeenCalledTimes(2);
    });

    it("does not show any friend-request notifications when the poll fails", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({ ok: false });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).not.toHaveBeenCalled();
    });

    it("skips the friend-request fetch entirely when friend-sync is no longer enabled/signed-in (same eligibility gate as the other two polls)", async () => {
      vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(null);
      const friendRequestPollSpy = vi.spyOn(friendRequestApi, "pollRelevantRequests");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(friendRequestPollSpy).not.toHaveBeenCalled();
    });

    it("a failed session-events or nudge poll does not prevent the friend-request cursor from advancing (the three streams are fully independent)", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: false,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: false });
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [],
      });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(await getLastFriendPollAt()).toBeNull();
      expect(await getLastNudgePollAt()).toBeNull();
      expect(await getLastFriendRequestPollAt()).toEqual(expect.any(Number));
    });
  });

  describe("digest polling (v2 Task 9 - reuses this same alarm, not a parallel one)", () => {
    function sampleDigest(overrides: Partial<FriendDigest> = {}): FriendDigest {
      return {
        friendUserId: "user-b",
        completedSessions: 3,
        abandonedSessions: 1,
        distractionCount: 2,
        recoveryRate: 0.5,
        digestDate: "2026-08-14",
        computedAt: Date.now(),
        ...overrides,
      };
    }

    it("dispatches to pollNewDigests when eligible, in the same tick as the other three streams", async () => {
      mockFriendSyncEligible();
      const digestPollSpy = vi
        .spyOn(digestApi, "pollNewDigests")
        .mockResolvedValue({ ok: true, digests: [] });
      const eventPollSpy = vi
        .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
        .mockResolvedValue({ ok: true, events: [] });
      const nudgePollSpy = vi
        .spyOn(nudgeApi, "pollIncomingNudges")
        .mockResolvedValue({ ok: true, nudges: [] });
      const friendRequestPollSpy = vi
        .spyOn(friendRequestApi, "pollRelevantRequests")
        .mockResolvedValue({ ok: true, requests: [] });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(digestPollSpy).toHaveBeenCalledTimes(1);
      expect(eventPollSpy).toHaveBeenCalledTimes(1);
      expect(nudgePollSpy).toHaveBeenCalledTimes(1);
      expect(friendRequestPollSpy).toHaveBeenCalledTimes(1);
    });

    it("shows a chrome.notifications toast, distinct from the other three streams' copy, for a friend's new digest", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({
        ok: true,
        digests: [sampleDigest({ friendUserId: "user-b", completedSessions: 4, distractionCount: 1 })],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-digest-user-b-2026-08-14",
        expect.objectContaining({
          title: "Daily digest",
          message: expect.stringContaining("4 sessions completed"),
        })
      );
    });

    // This task's DoD: "a friend who opted into digests ... sees one summary per day, not per
    // session." The current user's OWN digest row (RLS legitimately returns it too - see
    // digestApi.ts) must never generate a notification - that stream exists to tell a friend
    // about someone ELSE's digest, not to tell a user about their own stats.
    it("does NOT notify about the current user's own digest row", async () => {
      mockFriendSyncEligible("user-a");
      vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({
        ok: true,
        digests: [sampleDigest({ friendUserId: "user-a" })],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).not.toHaveBeenCalled();
    });

    it("persists the digest-poll timestamp only on a successful poll, independently of the other three cursors", async () => {
      mockFriendSyncEligible();
      vi.spyOn(sessionStatusSyncApi, "pollNewEventsForFriends").mockResolvedValue({
        ok: true,
        events: [],
      });
      vi.spyOn(nudgeApi, "pollIncomingNudges").mockResolvedValue({ ok: true, nudges: [] });
      vi.spyOn(friendRequestApi, "pollRelevantRequests").mockResolvedValue({
        ok: true,
        requests: [],
      });
      const digestPollSpy = vi
        .spyOn(digestApi, "pollNewDigests")
        .mockResolvedValue({ ok: true, digests: [] });
      expect(await getLastDigestPollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      const persisted = await getLastDigestPollAt();
      expect(persisted).toEqual(expect.any(Number));

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(digestPollSpy).toHaveBeenLastCalledWith(persisted);
    });

    // Mirrors Task 6/7/8's identical guarantee: a failed digest poll must not advance the
    // cursor, or a digest computed during the outage would be permanently lost once the next
    // tick starts counting from `now` instead of retrying the same window.
    it("does NOT advance the persisted digest cursor when the poll fails (ok: false), so the next tick retries the same window", async () => {
      mockFriendSyncEligible();
      const digestPollSpy = vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({ ok: false });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastDigestPollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastDigestPollAt()).toBeNull();

      expect(digestPollSpy).toHaveBeenCalledTimes(2);
    });

    it("does not show any digest notifications when the poll fails", async () => {
      mockFriendSyncEligible();
      vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({ ok: false });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).not.toHaveBeenCalled();
    });

    it("skips the digest fetch entirely when friend-sync is no longer enabled/signed-in (same eligibility gate as the other three polls)", async () => {
      vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(null);
      const digestPollSpy = vi.spyOn(digestApi, "pollNewDigests");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(digestPollSpy).not.toHaveBeenCalled();
    });

    it("only notifies once for the same digest row across repeated ticks (one summary per day, not per session) - a re-poll after the cursor advances past it does not re-notify", async () => {
      mockFriendSyncEligible("user-a");
      const digest = sampleDigest({ friendUserId: "user-b" });
      const digestPollSpy = vi.spyOn(digestApi, "pollNewDigests");
      digestPollSpy.mockResolvedValueOnce({ ok: true, digests: [digest] });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(createNotificationSpy).toHaveBeenCalledTimes(1);
      const cursorAfterTick1 = await getLastDigestPollAt();

      // Second tick: pollNewDigests is called with the now-advanced cursor - a real backend
      // would no longer return this same row (its computed_at no longer exceeds the cursor), so
      // the mock reflects that here rather than re-returning the same digest.
      digestPollSpy.mockResolvedValueOnce({ ok: true, digests: [] });
      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledTimes(1);
      expect(digestPollSpy).toHaveBeenLastCalledWith(cursorAfterTick1);
    });

    describe("v2 Task 10 Part C: local notification-preference gating (does not affect the fetch/cursor)", () => {
      it("suppresses the digest toast when digestNotificationsEnabled is false, but still advances the cursor", async () => {
        await settingsRepo.saveSettings({
          ...DEFAULT_USER_SETTINGS,
          digestNotificationsEnabled: false,
        });
        mockFriendSyncEligible("user-a");
        vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({
          ok: true,
          digests: [sampleDigest({ friendUserId: "user-b" })],
        });
        const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

        await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

        expect(createNotificationSpy).not.toHaveBeenCalled();
        expect(await getLastDigestPollAt()).toEqual(expect.any(Number));
      });

      it("suppresses the digest toast during configured quiet hours, but still advances the cursor", async () => {
        // Pinned system clock - see the identical nudge-toast quiet-hours test above for why
        // (the same [0,23) real-wall-clock-hour flake applies here).
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T12:00:00"));

        await settingsRepo.saveSettings({
          ...DEFAULT_USER_SETTINGS,
          quietHours: { startHour: 0, endHour: 23 },
        });
        mockFriendSyncEligible("user-a");
        vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({
          ok: true,
          digests: [sampleDigest({ friendUserId: "user-b" })],
        });
        const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

        await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

        expect(createNotificationSpy).not.toHaveBeenCalled();
        expect(await getLastDigestPollAt()).toEqual(expect.any(Number));
      });

      it("still shows the digest toast when notifications are enabled and no quiet hours are configured (unaffected by this task)", async () => {
        await settingsRepo.saveSettings(DEFAULT_USER_SETTINGS);
        mockFriendSyncEligible("user-a");
        vi.spyOn(digestApi, "pollNewDigests").mockResolvedValue({
          ok: true,
          digests: [sampleDigest({ friendUserId: "user-b" })],
        });
        const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

        await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

        expect(createNotificationSpy).toHaveBeenCalledWith(
          "friend-digest-user-b-2026-08-14",
          expect.objectContaining({ title: "Daily digest" })
        );
      });
    });
  });

  describe("producer tag polling (v2 Task 14 - reuses this same alarm, not a parallel one; friend-delivery side only)", () => {
    function sampleIncomingTag(overrides: Partial<IncomingProducerTag> = {}): IncomingProducerTag {
      return {
        tagId: "tag-1",
        senderUserId: "user-b",
        sentAt: 1_700_000_000_000,
        audioUrl: "tag-1/clip.webm",
        durationMs: 4000,
        ...overrides,
      };
    }

    it("dispatches to pollIncomingProducerTagSends when eligible, in the same tick as the other three streams", async () => {
      mockFriendSyncEligible();
      const producerTagPollSpy = vi
        .spyOn(producerTagApi, "pollIncomingProducerTagSends")
        .mockResolvedValue({ ok: true, sends: [] });
      const eventPollSpy = vi
        .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
        .mockResolvedValue({ ok: true, events: [] });
      const nudgePollSpy = vi
        .spyOn(nudgeApi, "pollIncomingNudges")
        .mockResolvedValue({ ok: true, nudges: [] });
      const friendRequestPollSpy = vi
        .spyOn(friendRequestApi, "pollRelevantRequests")
        .mockResolvedValue({ ok: true, requests: [] });
      const digestPollSpy = vi
        .spyOn(digestApi, "pollNewDigests")
        .mockResolvedValue({ ok: true, digests: [] });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(producerTagPollSpy).toHaveBeenCalledTimes(1);
      expect(eventPollSpy).toHaveBeenCalledTimes(1);
      expect(nudgePollSpy).toHaveBeenCalledTimes(1);
      expect(friendRequestPollSpy).toHaveBeenCalledTimes(1);
      expect(digestPollSpy).toHaveBeenCalledTimes(1);
    });

    it("shows a chrome.notifications toast for each new incoming producer tag, naming the sender", async () => {
      mockFriendSyncEligible();
      vi.spyOn(producerTagApi, "pollIncomingProducerTagSends").mockResolvedValue({
        ok: true,
        sends: [sampleIncomingTag({ senderUserId: "user-b" })],
      });
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "producer-tag-tag-1-1700000000000",
        expect.objectContaining({ title: "Producer tag from a friend" })
      );
    });

    it("persists the producer-tag-poll timestamp only on a successful poll, independently of the other five cursors", async () => {
      mockFriendSyncEligible();
      const producerTagPollSpy = vi
        .spyOn(producerTagApi, "pollIncomingProducerTagSends")
        .mockResolvedValue({ ok: true, sends: [] });
      expect(await getLastProducerTagPollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      const persisted = await getLastProducerTagPollAt();
      expect(persisted).toEqual(expect.any(Number));

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(producerTagPollSpy).toHaveBeenLastCalledWith(persisted);
    });

    it("does NOT advance the persisted producer-tag cursor when the poll fails (ok: false), so the next tick retries the same window", async () => {
      mockFriendSyncEligible();
      const producerTagPollSpy = vi
        .spyOn(producerTagApi, "pollIncomingProducerTagSends")
        .mockResolvedValue({ ok: false });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastProducerTagPollAt()).toBeNull();

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);
      expect(await getLastProducerTagPollAt()).toBeNull();

      expect(producerTagPollSpy).toHaveBeenCalledTimes(2);
    });

    it("skips the producer-tag fetch entirely when friend-sync is no longer enabled/signed-in (same eligibility gate as the other five polls)", async () => {
      vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(null);
      const producerTagPollSpy = vi.spyOn(producerTagApi, "pollIncomingProducerTagSends");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(producerTagPollSpy).not.toHaveBeenCalled();
    });
  });

  describe("friend connection polling (v3.4 Task 2 - reuses this same alarm, not a parallel one)", () => {
    // Query shape mirrors alarmHandlers.ts's pollFriendConnectionUpdates: friendships rows where
    // initiated_by = the current user, created since the last poll. No dedicated *Api.ts module
    // exists for this (see that function's own comment), so it's stubbed via supabase.from
    // directly rather than vi.spyOn on an Api export, same as the beforeEach default above.
    function mockFriendshipsQuery(rows: { user_id_a: string; user_id_b: string; initiated_by: string; created_at: string }[]) {
      vi.spyOn(supabase, "from").mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gt: vi.fn().mockResolvedValue({ data: rows, error: null }),
      } as never);
    }

    it("dispatches to a friendships query when eligible, in the same tick as the other five streams", async () => {
      mockFriendSyncEligible("user-a");
      mockFriendshipsQuery([]);
      const eventPollSpy = vi
        .spyOn(sessionStatusSyncApi, "pollNewEventsForFriends")
        .mockResolvedValue({ ok: true, events: [] });

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(eventPollSpy).toHaveBeenCalledTimes(1);
      expect(await getLastFriendConnectionPollAt()).not.toBeNull();
    });

    it("shows a chrome.notifications toast naming the friend by their human_name when a new connection this user's own invite generated is found", async () => {
      mockFriendSyncEligible("user-a");
      mockFriendshipsQuery([
        {
          user_id_a: "user-a",
          user_id_b: "user-b",
          initiated_by: "user-a",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
      vi.spyOn(profileApi, "fetchProfilesByIds").mockResolvedValue([
        { userId: "user-b", humanName: "Bea", bunnyName: null, updatedAt: "2026-01-01T00:00:00.000Z" },
      ]);
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-connection-user-b-2026-01-01T00:00:00.000Z",
        expect.objectContaining({
          title: "New friend connection",
          message: "Bea just connected using your invite",
        })
      );
    });

    it("falls back to the raw user id when the new friend has no profile name set", async () => {
      mockFriendSyncEligible("user-a");
      mockFriendshipsQuery([
        {
          user_id_a: "user-b",
          user_id_b: "user-a",
          initiated_by: "user-a",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
      vi.spyOn(profileApi, "fetchProfilesByIds").mockResolvedValue([]);
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).toHaveBeenCalledWith(
        "friend-connection-user-b-2026-01-01T00:00:00.000Z",
        expect.objectContaining({
          title: "New friend connection",
          message: "user-b just connected using your invite",
        })
      );
    });

    it("does not notify when there are no new connections (e.g. a row where initiated_by is the OTHER party, which the real `.eq(\"initiated_by\", userId)` filter would never return in the first place)", async () => {
      mockFriendSyncEligible("user-a");
      mockFriendshipsQuery([]);
      const createNotificationSpy = vi.spyOn(chrome.notifications, "create");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(createNotificationSpy).not.toHaveBeenCalled();
    });

    it("skips the fetch entirely when friend-sync is no longer enabled/signed-in (same eligibility gate as the other seven polls)", async () => {
      vi.spyOn(friendSync, "currentFriendSyncUserId").mockResolvedValue(null);
      const fromSpy = vi.spyOn(supabase, "from");

      await handleAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm);

      expect(fromSpy).not.toHaveBeenCalled();
    });
  });

  it("cancels the friend-poll alarm and records a gated SESSION_COMPLETED event on natural completion", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);
    // messageRouter.ts's SESSION_START also evaluates whether to start the friend-poll alarm
    // (currentFriendSyncUserId + hasAnyFriend, from friendSync.ts) - hasAnyFriend queries
    // friendships directly against the supabase singleton, so it's stubbed here to look like the
    // user has a friend, letting SESSION_START's own wiring start the alarm rather than needing a
    // manual scheduleFriendPollAlarm() call to simulate it.
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ user_id_a: "user-a" }], error: null }),
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

// v2 Task 12: the temp-unlock-relock alarm is a completely separate lifecycle from both the
// session-timer alarm and the friend-poll alarm above - fired by alarmsApi.ts's
// scheduleTempUnlockRelockAlarm (called from tempPasscodeApi.ts's redeemCode on a successful
// redemption), and must work regardless of friend-sync/group-membership state. These tests cover
// handleTempUnlockRelockAlarm's own guard logic directly against handleAlarm's dispatch, per this
// task's brief ("confirm rather than assume" a session is still around and still hard-restricted
// for the given hostname before re-adding a DNR rule).
describe("handleAlarm — temp-unlock-relock alarm (v2 Task 12)", () => {
  async function ruleExistsFor(hostname: string): Promise<boolean> {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.some((rule) => rule.condition.requestDomains?.includes(hostname));
  }

  async function removeRuleFor(hostname: string): Promise<void> {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const match = rules.find((rule) => rule.condition.requestDomains?.includes(hostname));
    if (!match) throw new Error(`No DNR rule found for ${hostname} to remove`);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [match.id] });
  }

  it("re-adds the DNR rule for the hostname when the session is still active and still hard-restricted for it (the actual re-lock)", async () => {
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "hard" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    expect(await ruleExistsFor("youtube.com")).toBe(true);

    // Simulate what redeemCode's successful-redemption unlock does.
    await removeRuleFor("youtube.com");
    expect(await ruleExistsFor("youtube.com")).toBe(false);

    await handleAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm);

    expect(await ruleExistsFor("youtube.com")).toBe(true);
  });

  it("is a no-op when there is no active session at all", async () => {
    await handleAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm);

    expect(await ruleExistsFor("youtube.com")).toBe(false);
  });

  it("is a no-op when the session that granted the unlock has since completed (clearHardBlockRules() already ran)", async () => {
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "hard" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await removeRuleFor("youtube.com");

    // Natural completion clears every remaining DNR rule (see the "clears hard-block DNR rules"
    // test above).
    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);
    expect(await chrome.declarativeNetRequest.getDynamicRules()).toEqual([]);

    await handleAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm);

    expect(await ruleExistsFor("youtube.com")).toBe(false);
  });

  it("is a no-op when the session that granted the unlock has since been abandoned", async () => {
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "hard" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await removeRuleFor("youtube.com");

    await handleMessage({ type: "SESSION_END", payload: { sessionId: created.session.id } });
    expect(await chrome.declarativeNetRequest.getDynamicRules()).toEqual([]);

    await handleAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm);

    expect(await ruleExistsFor("youtube.com")).toBe(false);
  });

  it("is a no-op when the hostname isn't part of the CURRENT session's restrictedSites (e.g. a new session started since the original grant)", async () => {
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["reddit.com"], restrictionMode: "hard" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    expect(await ruleExistsFor("reddit.com")).toBe(true);

    // A relock alarm for a hostname this session's own restrictedSites doesn't even contain -
    // stale from some earlier, different session.
    await handleAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm);

    expect(await ruleExistsFor("youtube.com")).toBe(false);
    // The unrelated, still-legitimately-blocked hostname's rule is untouched either way.
    expect(await ruleExistsFor("reddit.com")).toBe(true);
  });

  it("is a no-op when the active session is soft-mode (not hard-restricted at all)", async () => {
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "soft" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm);

    expect(await ruleExistsFor("youtube.com")).toBe(false);
  });

  it("does not throw and logs, rather than propagating, if the underlying declarativeNetRequest call fails", async () => {
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, restrictedSites: ["youtube.com"], restrictionMode: "hard" },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await removeRuleFor("youtube.com");

    vi.spyOn(chrome.declarativeNetRequest, "getDynamicRules").mockRejectedValueOnce(
      new Error("boom")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handleAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm)
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
