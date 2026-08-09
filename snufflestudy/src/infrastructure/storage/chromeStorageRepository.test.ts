import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ChromeStorageRepository } from "./chromeStorageRepository";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";
import { createHardBlockCredential } from "../../domain/sites/hardBlockCredential";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("ChromeStorageRepository", () => {
  const repo = new ChromeStorageRepository();

  it("returns default settings when none are saved", async () => {
    expect(await repo.getSettings()).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("saves and retrieves settings", async () => {
    const settings = { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true };
    await repo.saveSettings(settings);
    expect(await repo.getSettings()).toEqual(settings);
  });

  it("returns null when there is no active session", async () => {
    expect(await repo.getActiveSession()).toBeNull();
  });

  it("saves and retrieves the active session", async () => {
    const input: CreateSessionInput = {
      goal: "Read chapters 3 and 4",
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "strict-coach",
      allowedSites: [],
      restrictedSites: [],
      restrictionMode: "soft",
    };
    const session = machine.createSession(input, "session_1", 0);
    await repo.saveActiveSession(session);
    expect(await repo.getActiveSession()).toEqual(session);
  });

  it("clears the active session when saved as null", async () => {
    const input: CreateSessionInput = {
      goal: "Read chapters 3 and 4",
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "strict-coach",
      allowedSites: [],
      restrictedSites: [],
      restrictionMode: "soft",
    };
    const session = machine.createSession(input, "session_1", 0);
    await repo.saveActiveSession(session);
    await repo.saveActiveSession(null);
    expect(await repo.getActiveSession()).toBeNull();
  });

  it("saves and retrieves the hard-block credential", async () => {
    const credential = await createHardBlockCredential("1234");
    await repo.saveHardBlockCredential(credential);
    expect(await repo.getHardBlockCredential()).toEqual(credential);
  });
});
