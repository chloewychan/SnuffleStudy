import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleAlarm } from "./alarmHandlers";
import { handleMessage } from "./messageRouter";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
import { IndexedDbTaskRepository } from "../infrastructure/storage/taskRepository";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeDeclarativeNetRequest();
  indexedDB.deleteDatabase("snufflestudy");
  indexedDB.deleteDatabase("snufflestudy-tasks");
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
