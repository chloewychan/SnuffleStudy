import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import { handleAlarm } from "./alarmHandlers";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
import type { CreateSessionInput } from "../domain/session/sessionTypes";
import type { UserSettings } from "../domain/settings/userSettings";
import type { Task } from "../domain/tasks/taskTypes";

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
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
};

describe("messageRouter — full session lifecycle", () => {
  it("creates, starts, pauses, resumes, and ends a session", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      ok: boolean;
      session: { id: string; state: string };
    };
    expect(created.ok).toBe(true);
    expect(created.session.state).toBe("SESSION_SETUP");

    const sessionId = created.session.id;

    const started = (await handleMessage({ type: "SESSION_START", payload: { sessionId } })) as {
      session: { state: string };
    };
    expect(started.session.state).toBe("FOCUSING");

    const alarm = await chrome.alarms.get("snufflestudy-session-timer");
    expect(alarm).toBeDefined();

    const paused = (await handleMessage({ type: "SESSION_PAUSE", payload: { sessionId } })) as {
      session: { state: string };
    };
    expect(paused.session.state).toBe("PAUSED");
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeUndefined();

    const resumed = (await handleMessage({ type: "SESSION_RESUME", payload: { sessionId } })) as {
      session: { state: string };
    };
    expect(resumed.session.state).toBe("FOCUSING");

    const ended = (await handleMessage({
      type: "SESSION_END",
      payload: { sessionId },
    })) as { session: { state: string } };
    expect(ended.session.state).toBe("ABANDONED");

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).toBeNull();
  });

  it("shows a notification when a session is ended manually (abandoned)", async () => {
    // Regression guard: natural completion already notified (alarmHandlers.ts), but ending
    // early via SESSION_END was previously silent - "nothing happens" from the user's
    // perspective either way, since a manually-ended session gave no feedback at all.
    const createNotificationSpy = vi.spyOn(chrome.notifications, "create");
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleMessage({ type: "SESSION_END", payload: { sessionId: created.session.id } });

    expect(createNotificationSpy).toHaveBeenCalledWith(
      "session-abandoned",
      expect.objectContaining({ title: "Session ended" })
    );
  });

  it("rejects an invalid SESSION_CREATE with validation errors", async () => {
    const result = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, goal: "" },
    })) as { ok: boolean; errors: string[] };
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Goal cannot be empty.");
  });

  it("records a distraction attempt and updates the active session", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    const result = (await handleMessage({
      type: "DISTRACTION_ATTEMPT",
      payload: { sessionId: created.session.id, hostname: "youtube.com" },
    })) as { session: { distractionAttempts: number; interventionLevel: string } };

    expect(result.session.distractionAttempts).toBe(1);
    expect(result.session.interventionLevel).toBe("warned");
  });

  it("sets and verifies a hard-block passcode", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });

    const wrong = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "0000", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(wrong.ok).toBe(false);

    const right = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "1234", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(right.ok).toBe(true);
  });

  it("returns a graceful { ok: false, error } instead of throwing/rejecting when sessionId doesn't match an active session", async () => {
    await expect(
      handleMessage({ type: "SESSION_PAUSE", payload: { sessionId: "does-not-exist" } })
    ).resolves.toEqual({ ok: false, error: expect.any(String) });
  });

  it("saves and retrieves settings", async () => {
    const initial = (await handleMessage({ type: "SETTINGS_GET" })) as {
      settings: UserSettings;
    };
    expect(initial.settings.onboardingCompleted).toBe(false);

    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: { ...initial.settings, onboardingCompleted: true },
    });

    const updated = (await handleMessage({ type: "SETTINGS_GET" })) as {
      settings: { onboardingCompleted: boolean };
    };
    expect(updated.settings.onboardingCompleted).toBe(true);
  });
});

describe("messageRouter — SESSION_END hard-block enforcement", () => {
  const hardInput: CreateSessionInput = {
    ...createInput,
    restrictionMode: "hard",
  };

  async function createAndStartHardSession(): Promise<string> {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: hardInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    return created.session.id;
  }

  it("ends a hard-mode session with a configured credential when given the correct passcode", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });
    const sessionId = await createAndStartHardSession();

    const ended = (await handleMessage({
      type: "SESSION_END",
      payload: { sessionId, passcode: "1234" },
    })) as { ok: boolean; session: { state: string } };

    expect(ended.ok).toBe(true);
    expect(ended.session.state).toBe("ABANDONED");

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).toBeNull();
  });

  it("rejects SESSION_END on a hard-mode session with a configured credential when given an incorrect passcode, leaving the session active", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });
    const sessionId = await createAndStartHardSession();

    const result = (await handleMessage({
      type: "SESSION_END",
      payload: { sessionId, passcode: "0000" },
    })) as { ok: boolean };

    expect(result.ok).toBe(false);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { id: string; state: string } | null;
    };
    expect(active.session).not.toBeNull();
    expect(active.session?.id).toBe(sessionId);
    expect(active.session?.state).toBe("FOCUSING");
  });

  it("rejects SESSION_END on a hard-mode session with a configured credential when no passcode is supplied in the payload", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });
    const sessionId = await createAndStartHardSession();

    const result = (await handleMessage({
      type: "SESSION_END",
      payload: { sessionId },
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/passcode required/i);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).not.toBeNull();
  });

  it("ends a hard-mode session with NO configured credential without requiring a passcode", async () => {
    const sessionId = await createAndStartHardSession();

    const ended = (await handleMessage({
      type: "SESSION_END",
      payload: { sessionId },
    })) as { ok: boolean; session: { state: string } };

    expect(ended.ok).toBe(true);
    expect(ended.session.state).toBe("ABANDONED");

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).toBeNull();
  });

  it("ends a soft-mode session normally regardless of whether a passcode field is present in the payload", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    const ended = (await handleMessage({
      type: "SESSION_END",
      payload: { sessionId: created.session.id, passcode: "irrelevant" },
    })) as { ok: boolean; session: { state: string } };

    expect(ended.ok).toBe(true);
    expect(ended.session.state).toBe("ABANDONED");
  });
});

describe("messageRouter — HARD_BLOCK_SET_PASSCODE requires the current passcode to change an existing one", () => {
  it("succeeds on first-time setup with no existing credential and no oldPasscode", async () => {
    const result = (await handleMessage({
      type: "HARD_BLOCK_SET_PASSCODE",
      payload: { passcode: "1234" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const verified = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "1234", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(verified.ok).toBe(true);
  });

  it("replaces an existing credential when the correct oldPasscode is supplied, and the new passcode actually takes effect", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });

    const result = (await handleMessage({
      type: "HARD_BLOCK_SET_PASSCODE",
      payload: { passcode: "5678", oldPasscode: "1234" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const oldStillWorks = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "1234", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(oldStillWorks.ok).toBe(false);

    const newWorks = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "5678", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(newWorks.ok).toBe(true);
  });

  it("rejects replacing an existing credential when oldPasscode is missing, leaving the old passcode working afterward", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });

    const result = (await handleMessage({
      type: "HARD_BLOCK_SET_PASSCODE",
      payload: { passcode: "0000" },
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/current passcode required/i);

    const oldStillWorks = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "1234", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(oldStillWorks.ok).toBe(true);
  });

  it("rejects replacing an existing credential when oldPasscode is wrong, leaving the old passcode working afterward", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });

    const result = (await handleMessage({
      type: "HARD_BLOCK_SET_PASSCODE",
      payload: { passcode: "0000", oldPasscode: "9999" },
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/incorrect current passcode/i);

    const oldStillWorks = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "1234", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(oldStillWorks.ok).toBe(true);

    const attackerPasscodeDoesNotWork = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "0000", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(attackerPasscodeDoesNotWork.ok).toBe(false);
  });
});

describe("messageRouter — HARD_BLOCK_VERIFY_PASSCODE unlocks only the verified hostname's DNR rule", () => {
  const hardTwoSiteInput: CreateSessionInput = {
    ...createInput,
    restrictedSites: ["youtube.com", "reddit.com"],
    restrictionMode: "hard",
  };

  it("removes only hostname A's rule on a correct passcode, leaving hostname B's rule blocking", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: hardTwoSiteInput,
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    const beforeRules = await chrome.declarativeNetRequest.getDynamicRules();
    expect(beforeRules).toHaveLength(2);

    const result = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "1234", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const afterRules = await chrome.declarativeNetRequest.getDynamicRules();
    expect(afterRules).toHaveLength(1);
    expect(
      afterRules.some((rule) => rule.condition.requestDomains?.includes("youtube.com"))
    ).toBe(false);
    expect(
      afterRules.some((rule) => rule.condition.requestDomains?.includes("reddit.com"))
    ).toBe(true);
  });

  it("leaves both rules untouched when the passcode is wrong", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: hardTwoSiteInput,
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    const result = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "0000", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(result.ok).toBe(false);

    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    expect(rules).toHaveLength(2);
    expect(rules.some((rule) => rule.condition.requestDomains?.includes("youtube.com"))).toBe(
      true
    );
    expect(rules.some((rule) => rule.condition.requestDomains?.includes("reddit.com"))).toBe(
      true
    );
  });
});

describe("messageRouter — SESSION_DISMISS_COMPLETED", () => {
  it("clears a COMPLETED session when dismissed", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const beforeDismiss = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { state: string } | null;
    };
    expect(beforeDismiss.session?.state).toBe("COMPLETED");

    const result = (await handleMessage({
      type: "SESSION_DISMISS_COMPLETED",
      payload: { sessionId: created.session.id },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const afterDismiss = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(afterDismiss.session).toBeNull();
  });

  it("rejects dismissing a session that is not COMPLETED, leaving it untouched", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    const result = (await handleMessage({
      type: "SESSION_DISMISS_COMPLETED",
      payload: { sessionId: created.session.id },
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/FOCUSING/);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { state: string } | null;
    };
    expect(active.session?.state).toBe("FOCUSING");
  });
});

describe("messageRouter — RETURN_TO_WORK_CLOSE_TAB", () => {
  it("closes the sender's tab when one is present", async () => {
    const removeSpy = vi.spyOn(chrome.tabs, "remove").mockResolvedValue(undefined);

    const result = (await handleMessage(
      { type: "RETURN_TO_WORK_CLOSE_TAB" },
      { tab: { id: 42 } } as chrome.runtime.MessageSender
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith(42);
  });

  it("returns a graceful error instead of throwing when there is no sender tab", async () => {
    // messageRouter.test.ts doesn't restore mocks between tests, so an explicit mockClear()
    // is needed here - otherwise this spy would still carry the call recorded by the
    // previous test's own vi.spyOn on the same chrome.tabs.remove.
    const removeSpy = vi.spyOn(chrome.tabs, "remove").mockClear();

    const result = (await handleMessage({ type: "RETURN_TO_WORK_CLOSE_TAB" })) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no tab/i);
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe("messageRouter — SESSION_LIST_HISTORY / SESSION_LIST_EVENTS", () => {
  it("lists an abandoned session via SESSION_LIST_HISTORY, newest first", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await handleMessage({ type: "SESSION_END", payload: { sessionId: created.session.id } });

    const result = (await handleMessage({
      type: "SESSION_LIST_HISTORY",
      payload: {},
    })) as { ok: boolean; sessions: { id: string; state: string }[] };

    expect(result.ok).toBe(true);
    expect(result.sessions.map((s) => s.id)).toContain(created.session.id);
    expect(result.sessions.find((s) => s.id === created.session.id)?.state).toBe("ABANDONED");
  });

  it("filters SESSION_LIST_HISTORY by state, passing the HistoryQuery payload through directly", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await handleMessage({ type: "SESSION_END", payload: { sessionId: created.session.id } });

    const result = (await handleMessage({
      type: "SESSION_LIST_HISTORY",
      payload: { state: "COMPLETED" },
    })) as { ok: boolean; sessions: { id: string }[] };

    expect(result.ok).toBe(true);
    expect(result.sessions.map((s) => s.id)).not.toContain(created.session.id);
  });

  it("lists a session's recorded events via SESSION_LIST_EVENTS", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });
    await handleMessage({
      type: "DISTRACTION_ATTEMPT",
      payload: { sessionId: created.session.id, hostname: "youtube.com" },
    });

    const result = (await handleMessage({
      type: "SESSION_LIST_EVENTS",
      payload: { sessionId: created.session.id },
    })) as { ok: boolean; events: { type: string; hostname?: string }[] };

    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "DISTRACTION_ATTEMPT", hostname: "youtube.com" });
  });

  it("returns an empty list from SESSION_LIST_EVENTS for a session with no recorded events", async () => {
    const result = (await handleMessage({
      type: "SESSION_LIST_EVENTS",
      payload: { sessionId: "nonexistent-session" },
    })) as { ok: boolean; events: unknown[] };

    expect(result.ok).toBe(true);
    expect(result.events).toEqual([]);
  });
});

describe("messageRouter — TASK_CREATE / TASK_UPDATE / TASK_DELETE / TASK_LIST / TASK_ADD_BREAKDOWN_ITEM", () => {
  it("creates a task and lists it", async () => {
    const created = (await handleMessage({
      type: "TASK_CREATE",
      payload: { title: "STAT231" },
    })) as { ok: boolean; task: { id: string; title: string; breakdown: unknown[] } };

    expect(created.ok).toBe(true);
    expect(created.task.title).toBe("STAT231");
    expect(created.task.breakdown).toEqual([]);

    const listed = (await handleMessage({ type: "TASK_LIST" })) as {
      ok: boolean;
      tasks: { id: string }[];
    };
    expect(listed.tasks.map((t) => t.id)).toContain(created.task.id);
  });

  it("adds a breakdown item to a task via TASK_ADD_BREAKDOWN_ITEM", async () => {
    const created = (await handleMessage({
      type: "TASK_CREATE",
      payload: { title: "STAT231" },
    })) as { task: { id: string } };

    const result = (await handleMessage({
      type: "TASK_ADD_BREAKDOWN_ITEM",
      payload: { taskId: created.task.id, description: "Chapter 6 of STAT231" },
    })) as { ok: boolean; task: { breakdown: { id: string; description: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.task.breakdown).toHaveLength(1);
    expect(result.task.breakdown[0]!.description).toBe("Chapter 6 of STAT231");
  });

  it("updates a task via TASK_UPDATE", async () => {
    const created = (await handleMessage({
      type: "TASK_CREATE",
      payload: { title: "STAT231" },
    })) as { task: Task };

    await handleMessage({
      type: "TASK_UPDATE",
      payload: { ...created.task, title: "STAT231 (renamed)" },
    });

    const listed = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { id: string; title: string }[];
    };
    expect(listed.tasks.find((t) => t.id === created.task.id)?.title).toBe("STAT231 (renamed)");
  });

  it("deletes a task via TASK_DELETE", async () => {
    const created = (await handleMessage({
      type: "TASK_CREATE",
      payload: { title: "STAT231" },
    })) as { task: { id: string } };

    const result = (await handleMessage({
      type: "TASK_DELETE",
      payload: { taskId: created.task.id },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const listed = (await handleMessage({ type: "TASK_LIST" })) as { tasks: { id: string }[] };
    expect(listed.tasks.map((t) => t.id)).not.toContain(created.task.id);
  });
});

describe("messageRouter — SESSION_END marks a linked task breakdown item's completedAt", () => {
  it("marks the breakdown item complete when the ending session has a taskBreakdownItemId", async () => {
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
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: createdSession.session.id } });

    await handleMessage({ type: "SESSION_END", payload: { sessionId: createdSession.session.id } });

    const listed = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { id: string; breakdown: { id: string; completedAt?: number }[] }[];
    };
    const item = listed.tasks
      .find((t) => t.id === createdTask.task.id)
      ?.breakdown.find((i) => i.id === breakdownItemId);
    expect(item?.completedAt).toEqual(expect.any(Number));
  });

  it("does not touch any task when the ending session has no taskBreakdownItemId", async () => {
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
    await handleMessage({ type: "SESSION_END", payload: { sessionId: createdSession.session.id } });

    const listed = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { id: string; breakdown: { id: string; completedAt?: number }[] }[];
    };
    const item = listed.tasks
      .find((t) => t.id === createdTask.task.id)
      ?.breakdown.find((i) => i.id === withItem.task.breakdown[0]!.id);
    expect(item?.completedAt).toBeUndefined();
  });
});
