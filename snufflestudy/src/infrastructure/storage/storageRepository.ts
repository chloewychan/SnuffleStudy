import type { StudySession } from "../../domain/session/sessionTypes";
import type { UserSettings } from "../../domain/settings/userSettings";
import type { HardBlockCredential } from "../../domain/sites/hardBlockCredential";

export interface SettingsRepository {
  getSettings(): Promise<UserSettings>;
  saveSettings(settings: UserSettings): Promise<void>;
  getActiveSession(): Promise<StudySession | null>;
  saveActiveSession(session: StudySession | null): Promise<void>;
  getHardBlockCredential(): Promise<HardBlockCredential | null>;
  saveHardBlockCredential(credential: HardBlockCredential | null): Promise<void>;
}
