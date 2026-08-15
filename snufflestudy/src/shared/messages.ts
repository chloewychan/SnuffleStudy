import type { CreateSessionInput, HistoryQuery, SessionState } from "../domain/session/sessionTypes";
import type { UserSettings } from "../domain/settings/userSettings";
import type { Task } from "../domain/tasks/taskTypes";
import type { FriendshipSettingsPatch } from "../infrastructure/backend/friendshipSettingsApi";

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
  | { type: "GROUP_LIST_MEMBERS"; payload: { groupId: string } }
  // v2 Task 7: routes to friendGroupApi.listMyGroups() - lets FriendGroupPanel.tsx discover
  // which group(s) the current user is in (so it can then GROUP_LIST_MEMBERS per group) without
  // the user having to paste a groupId in, unlike AccountPage.tsx's manual-entry flow.
  | { type: "GROUP_LIST_MINE" }
  // v2 Task 6: routes to sessionStatusSyncApi.fetchNewEventsForFriends via messageRouter.ts -
  // used by both alarmHandlers.ts's friend-poll alarm (indirectly, via a direct function call
  // since that's background-side code, not a message) and FriendGroupPanel.tsx (this message,
  // since UI components never import infrastructure/backend/* directly - see messageRouter.ts's
  // architecture note).
  | { type: "FRIEND_EVENTS_FETCH"; payload: { sinceTimestamp: number } }
  // v2 Task 7: routes to nudgeApi.sendNudge - the toggle/cooldown rejection happens entirely
  // server-side (see supabase/migrations/20260815000007_v2_nudges.sql's can_send_nudge()); this
  // handler is a thin pass-through, same convention as every other message case in
  // messageRouter.ts.
  | { type: "NUDGE_SEND"; payload: { friendUserId: string; messageId: string } }
  // v2 Task 7: routes to nudgeApi.fetchIncomingNudges - the on-demand counterpart to
  // FRIEND_EVENTS_FETCH above, used by FriendGroupPanel.tsx to render incoming nudges. The
  // background's alarm-driven poll (alarmHandlers.ts) calls nudgeApi.pollIncomingNudges directly
  // rather than through this message, mirroring FRIEND_EVENTS_FETCH/pollNewEventsForFriends's
  // split.
  | { type: "NUDGES_FETCH"; payload: { sinceTimestamp: number } }
  // v2 Task 8: routes to unlockRequestApi.createRequest - UnlockRequestPanel.tsx's requester
  // side. sessionId is the currently active session the requested hostname should be unlocked
  // for; unlockRequestApi.createRequest throws on failure (not signed in, insert error), which
  // messageRouter.ts's outer handleMessage try/catch turns into ok:false, same convention as
  // GROUP_CREATE/GROUP_JOIN.
  | { type: "UNLOCK_REQUEST_CREATE"; payload: { sessionId: string; hostname: string } }
  // v2 Task 8: routes to unlockRequestApi.resolveRequest - UnlockRequestPanel.tsx's friend
  // (approve/deny) side. "First responder wins" is enforced server-side (RLS - see
  // supabase/migrations/20260815000008_v2_unlock_request_group_visibility.sql), not by this
  // message or unlockRequestApi.ts pre-checking anything client-side - a second friend's resolve
  // attempt on an already-resolved request throws, surfaced the same ok:false way.
  | { type: "UNLOCK_REQUEST_RESOLVE"; payload: { requestId: string; decision: "approved" | "denied" } }
  // v2 Task 8: routes to unlockRequestApi.fetchRelevantUnlockRequests - the on-demand
  // counterpart to the background's alarm-driven poll (alarmHandlers.ts calls
  // unlockRequestApi.pollRelevantUnlockRequests directly, mirroring
  // FRIEND_EVENTS_FETCH/NUDGES_FETCH's identical split). A single query covers both this panel's
  // needs: the requester's own requests (any status) and pending requests from anyone sharing a
  // group with the current user - see unlockRequestApi.ts's queryRelevantSince comment.
  | { type: "UNLOCK_REQUESTS_FETCH"; payload: { sinceTimestamp: number } }
  // v2 Task 9: routes to digestApi.fetchDigestForDate - the on-demand counterpart to the
  // background's alarm-driven poll (alarmHandlers.ts calls digestApi.pollNewDigests directly,
  // mirroring FRIEND_EVENTS_FETCH/NUDGES_FETCH/UNLOCK_REQUESTS_FETCH's identical split). `date`
  // is a YYYY-MM-DD calendar date (daily_digests.digest_date's type); FriendGroupPanel.tsx picks
  // which date to request (see that file's own comment on why it defaults to yesterday).
  | { type: "DIGEST_FETCH"; payload: { date: string } }
  // v2 Task 10, Part A: routes to friendshipSettingsApi.listMyFriendshipSettings() - the new
  // Friends section in OptionsApp.tsx uses this to enumerate the current user's settings row
  // toward every friend they share a group with (all eight boolean columns: the three
  // pre-existing plus Task 10's five new share_* toggles).
  | { type: "FRIENDSHIP_SETTINGS_LIST" }
  // v2 Task 10, Part A: routes to friendshipSettingsApi.updateFriendshipSettings() - a single
  // field (or several) at a time, keyed by which friend the change applies to. Throws on failure
  // (e.g. no row exists yet because the two users don't actually share a group), which
  // messageRouter.ts's outer handleMessage try/catch turns into ok:false, same convention as
  // GROUP_CREATE/GROUP_JOIN/UNLOCK_REQUEST_CREATE.
  | {
      type: "FRIENDSHIP_SETTINGS_UPDATE";
      payload: { friendUserId: string; patch: FriendshipSettingsPatch };
    };
