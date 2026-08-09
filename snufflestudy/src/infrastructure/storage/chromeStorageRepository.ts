import type { SettingsRepository } from "./storageRepository";
import type { UserSettings } from "../../domain/settings/userSettings";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import type { StudySession } from "../../domain/session/sessionTypes";
import type { HardBlockCredential } from "../../domain/sites/hardBlockCredential";

const KEYS = {
  settings: "snufflestudy.settings",
  activeSession: "snufflestudy.activeSession",
  hardBlockCredential: "snufflestudy.hardBlockCredential",
} as const;

export class ChromeStorageRepository implements SettingsRepository {
  async getSettings(): Promise<UserSettings> {
    const result = await chrome.storage.local.get(KEYS.settings);
    return result[KEYS.settings] ?? DEFAULT_USER_SETTINGS;
  }

  async saveSettings(settings: UserSettings): Promise<void> {
    await chrome.storage.local.set({ [KEYS.settings]: settings });
  }

  async getActiveSession(): Promise<StudySession | null> {
    const result = await chrome.storage.local.get(KEYS.activeSession);
    return result[KEYS.activeSession] ?? null;
  }

  async saveActiveSession(session: StudySession | null): Promise<void> {
    if (session === null) {
      await chrome.storage.local.remove(KEYS.activeSession);
      return;
    }
    await chrome.storage.local.set({ [KEYS.activeSession]: session });
  }

  async getHardBlockCredential(): Promise<HardBlockCredential | null> {
    const result = await chrome.storage.local.get(KEYS.hardBlockCredential);
    return result[KEYS.hardBlockCredential] ?? null;
  }

  async saveHardBlockCredential(credential: HardBlockCredential | null): Promise<void> {
    if (credential === null) {
      await chrome.storage.local.remove(KEYS.hardBlockCredential);
      return;
    }
    await chrome.storage.local.set({ [KEYS.hardBlockCredential]: credential });
  }
}
