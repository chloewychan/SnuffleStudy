import type { CreateSessionInput } from "../domain/session/sessionTypes";
import type { UserSettings } from "../domain/settings/userSettings";

export type ExtensionMessage =
  | { type: "SESSION_CREATE"; payload: CreateSessionInput }
  | { type: "SESSION_START"; payload: { sessionId: string } }
  | { type: "SESSION_PAUSE"; payload: { sessionId: string } }
  | { type: "SESSION_RESUME"; payload: { sessionId: string } }
  | { type: "SESSION_START_BREAK"; payload: { sessionId: string } }
  | { type: "SESSION_END_BREAK"; payload: { sessionId: string } }
  | { type: "SESSION_END"; payload: { sessionId: string; reason?: string; passcode?: string } }
  | { type: "SESSION_GET_ACTIVE" }
  | { type: "SITE_STATUS_REQUEST"; payload: { hostname: string | null } }
  | { type: "DISTRACTION_ATTEMPT"; payload: { sessionId: string; hostname: string } }
  | { type: "MARK_SITE_STUDY_RELATED"; payload: { sessionId: string; hostname: string } }
  | { type: "HARD_BLOCK_SET_PASSCODE"; payload: { passcode: string } }
  | { type: "HARD_BLOCK_VERIFY_PASSCODE"; payload: { passcode: string; hostname: string } }
  | { type: "SETTINGS_GET" }
  | { type: "SETTINGS_SAVE"; payload: UserSettings };
