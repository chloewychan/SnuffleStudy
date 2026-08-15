import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as sessionStatusSyncApi from "../infrastructure/backend/sessionStatusSyncApi";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { DEFAULT_USER_SETTINGS } from "../domain/settings/userSettings";
import { currentFriendSyncUserId, isInAnyGroup, recordFriendStatusEvent } from "./friendSync";

const settingsRepo = new ChromeStorageRepository();

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe("friendSync.currentFriendSyncUserId", () => {
  it("returns null without touching Supabase auth when friendSyncEnabled is off (the default)", async () => {
    await settingsRepo.saveSettings(DEFAULT_USER_SETTINGS);
    const getSessionSpy = vi.spyOn(supabase.auth, "getSession");

    const result = await currentFriendSyncUserId();

    expect(result).toBeNull();
    expect(getSessionSpy).not.toHaveBeenCalled();
  });

  it("returns null when friendSyncEnabled is on but there is no authenticated session", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: null,
    } as never);

    expect(await currentFriendSyncUserId()).toBeNull();
  });

  it("returns the user id when friendSyncEnabled is on and signed in", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);

    expect(await currentFriendSyncUserId()).toBe("user-a");
  });

  it("returns null (does not throw) when getSession throws", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await currentFriendSyncUserId()).toBeNull();
  });
});

describe("friendSync.isInAnyGroup", () => {
  it("returns true when group_memberships has at least one row for the user", async () => {
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ group_id: "group-1" }], error: null }),
    } as never);

    expect(await isInAnyGroup("user-a")).toBe(true);
    expect(fromSpy).toHaveBeenCalledWith("group_memberships");
  });

  it("returns false when the user has no group memberships", async () => {
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as never);

    expect(await isInAnyGroup("user-a")).toBe(false);
  });

  it("returns false (does not throw) on a query error", async () => {
    vi.spyOn(supabase, "from").mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
    } as never);

    expect(await isInAnyGroup("user-a")).toBe(false);
  });
});

describe("friendSync.recordFriendStatusEvent", () => {
  it("calls sessionStatusSyncApi.recordStatusEvent when signed in and friendSyncEnabled", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);
    const recordSpy = vi.spyOn(sessionStatusSyncApi, "recordStatusEvent").mockResolvedValue(undefined);

    recordFriendStatusEvent("SESSION_STARTED", "session-1", "started a focus session");
    // Fire-and-forget - give the promise chain a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recordSpy).toHaveBeenCalledWith({
      type: "SESSION_STARTED",
      sessionId: "session-1",
      displayLabel: "started a focus session",
    });
  });

  it("does not call recordStatusEvent when friendSyncEnabled is off (zero network cost)", async () => {
    await settingsRepo.saveSettings(DEFAULT_USER_SETTINGS);
    const getSessionSpy = vi.spyOn(supabase.auth, "getSession");
    const recordSpy = vi.spyOn(sessionStatusSyncApi, "recordStatusEvent");

    recordFriendStatusEvent("SESSION_STARTED", "session-1", "started a focus session");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("does not call recordStatusEvent when enabled but signed out", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: null,
    } as never);
    const recordSpy = vi.spyOn(sessionStatusSyncApi, "recordStatusEvent");

    recordFriendStatusEvent("SESSION_STARTED", "session-1", "started a focus session");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("swallows a rejection from recordStatusEvent instead of throwing", async () => {
    await settingsRepo.saveSettings({ ...DEFAULT_USER_SETTINGS, friendSyncEnabled: true });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { user: { id: "user-a" } } },
      error: null,
    } as never);
    vi.spyOn(sessionStatusSyncApi, "recordStatusEvent").mockRejectedValue(new Error("boom"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      recordFriendStatusEvent("SESSION_STARTED", "session-1", "started a focus session")
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
