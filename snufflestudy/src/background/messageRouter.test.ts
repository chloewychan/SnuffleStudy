import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import { stubFakeDeclarativeNetRequest } from "./testSupport/fakeDeclarativeNetRequest";
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
