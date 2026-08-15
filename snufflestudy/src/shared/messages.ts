import type { CreateSessionInput, HistoryQuery, SessionState } from "../domain/session/sessionTypes";
import type { UserSettings } from "../domain/settings/userSettings";
import type { Task } from "../domain/tasks/taskTypes";

export type ExtensionMessage =
  // taskBreakdownItemId lives here (not on CreateSessionInput itself - see sessionTypes.ts's
  // comment on StudySession.taskBreakdownItemId) since this file has no restriction against
  // additive changes. messageRouter.ts's SESSION_CREATE handler reads it off this payload and
  // merges it onto the StudySession it saves.
  | { type: "SESSION_CREATE"; payload: CreateSessionInput & { taskBreakdownItemId?: string } }
  | { type: "SESSION_START"; payload: { sessionId: string } }
  | { type: "SESSION_PAUSE"; payload: { sessionId: string } }
  | { type: "SESSION_RESUME"; payload: { sessionId: string } }
  | { type: "SESSION_START_BREAK"; payload: { sessionId: string } }
  | { type: "SESSION_END_BREAK"; payload: { sessionId: string } }
  | { type: "SESSION_END"; payload: { sessionId: string; reason?: string; passcode?: string } }
  | { type: "SESSION_DISMISS_COMPLETED"; payload: { sessionId: string } }
  | { type: "SESSION_DISMISS_ABANDONED"; payload: { sessionId: string } }
  | { type: "SESSION_GET_ACTIVE" }
  | { type: "SITE_STATUS_REQUEST"; payload: { hostname: string | null } }
  | { type: "DISTRACTION_ATTEMPT"; payload: { sessionId: string; hostname: string } }
  | { type: "MARK_SITE_STUDY_RELATED"; payload: { sessionId: string; hostname: string } }
  | { type: "RETURN_TO_WORK_CLOSE_TAB" }
  | { type: "HARD_BLOCK_SET_PASSCODE"; payload: { passcode: string; oldPasscode?: string } }
  | { type: "HARD_BLOCK_VERIFY_PASSCODE"; payload: { passcode: string; hostname: string } }
  | { type: "SETTINGS_GET" }
  | { type: "SETTINGS_SAVE"; payload: UserSettings }
  | { type: "SESSION_LIST_HISTORY"; payload: HistoryQuery }
  | { type: "SESSION_COUNT_BY_STATE"; payload: { state: SessionState } }
  | { type: "SESSION_LIST_EVENTS"; payload: { sessionId: string } }
  | { type: "TASK_CREATE"; payload: { title: string } }
  | { type: "TASK_UPDATE"; payload: Task }
  | { type: "TASK_DELETE"; payload: { taskId: string } }
  | { type: "TASK_LIST" }
  | { type: "TASK_ADD_BREAKDOWN_ITEM"; payload: { taskId: string; description: string } }
  // Auth: OTP code-entry flow, not magic-link-click - see messageRouter.ts's AUTH_* cases for
  // why (a clickable link's redirect target would need a chrome-extension://<id>/... URL
  // registered with Supabase, and the extension ID differs between dev/unpacked and published
  // builds; signInWithOtp's email contains both a link and a 6-digit code, and only the code
  // path is used here).
  | { type: "AUTH_REQUEST_OTP"; payload: { email: string } }
  | { type: "AUTH_VERIFY_OTP"; payload: { email: string; token: string } }
  | { type: "AUTH_SIGN_OUT" }
  | { type: "AUTH_GET_SESSION" }
  | { type: "GROUP_CREATE"; payload: { name: string } }
  | { type: "GROUP_GENERATE_INVITE_CODE"; payload: { groupId: string } }
  | { type: "GROUP_JOIN"; payload: { code: string } }
  | { type: "GROUP_LIST_MEMBERS"; payload: { groupId: string } };
