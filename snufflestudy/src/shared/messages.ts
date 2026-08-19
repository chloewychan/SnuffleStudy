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
    }
  // v2 Task 12: routes to tempPasscodeApi.createRequest - LockedPage.tsx's requester-side
  // "request a temporary passcode" action. sessionId/hostname mirror UNLOCK_REQUEST_CREATE's
  // shape; friendUserId is the picked designated friend (from GROUP_LIST_MINE/GROUP_LIST_MEMBERS,
  // same friend-picker pattern FriendGroupPanel.tsx/UnlockRequestPanel.tsx already use).
  // createRequest throws on failure (not signed in, insert error) - the outer handleMessage
  // try/catch turns that into ok:false, same convention as UNLOCK_REQUEST_CREATE.
  | {
      type: "TEMP_PASSCODE_CREATE";
      payload: { sessionId: string; hostname: string; friendUserId: string };
    }
  // v2 Task 12: routes to tempPasscodeApi.approveRequest - the assigned friend's approve action
  // (TempPasscodePanel.tsx). Returns the plaintext code exactly once, in this response only -
  // never stored anywhere. Throws on failure (not the assigned friend, already resolved, Edge
  // Function error) - same outer-catch convention as above.
  | { type: "TEMP_PASSCODE_APPROVE"; payload: { requestId: string } }
  // v2 Task 12: routes to tempPasscodeApi.denyRequest - the assigned friend's deny action
  // (TempPasscodePanel.tsx), the plan's UI brief calls for "an approve/deny action" though only
  // approveRequest appears in the plan's literal Interfaces line - deny needs no server-side
  // crypto (it never touches code_hash/code_salt), so it's a direct client-side table update,
  // unlike TEMP_PASSCODE_APPROVE. Throws on failure (already resolved / not the assigned friend) -
  // same outer-catch convention as above.
  | { type: "TEMP_PASSCODE_DENY"; payload: { requestId: string } }
  // v2 Task 12: routes to tempPasscodeApi.redeemCode - LockedPage.tsx's requester-side "enter the
  // code" action, once the request's status is 'approved'. On {ok:true}, redeemCode itself also
  // performs the actual unlock (unlockHardBlockRuleForHostname + scheduleTempUnlockRelockAlarm) -
  // this case is a thin pass-through, same convention as HARD_BLOCK_VERIFY_PASSCODE.
  | { type: "TEMP_PASSCODE_REDEEM"; payload: { requestId: string; code: string } }
  // v2 Task 12: routes to tempPasscodeApi.fetchRelevantTempPasscodeRequests - the on-demand
  // counterpart to the background's alarm-driven poll (alarmHandlers.ts calls
  // tempPasscodeApi.pollRelevantTempPasscodeRequests directly, mirroring
  // UNLOCK_REQUESTS_FETCH/pollRelevantUnlockRequests's identical split). Not named in the plan's
  // literal Interfaces line, but necessary - without an on-demand fetch, neither LockedPage.tsx
  // (checking its own request's status) nor TempPasscodePanel.tsx (listing pending requests to
  // review) has anything to render from.
  | { type: "TEMP_PASSCODE_REQUESTS_FETCH"; payload: { sinceTimestamp: number } }
  // v2 Task 13, fix round 1 (Important, code review): routes to studyRoomApi.createRoom -
  // StudyRoomPanel.tsx's create-room action. Plain one-shot DB write with no live-callback or
  // DOM/media coupling, so - unlike joinRoom/subscribeToPresence (see studyRoomApi.ts's own
  // header comment on why those two stay a direct, narrower exception) - there's no reason for
  // this to skip the same message-passing convention every other *Api.ts write goes through.
  // Throws on failure (not signed in, RLS-denied insert) - the outer handleMessage try/catch
  // turns that into ok:false, same convention as GROUP_CREATE.
  | { type: "STUDY_ROOM_CREATE"; payload: { name: string } }
  // v2 Task 13, fix round 1: routes to studyRoomApi.listRooms - StudyRoomPanel.tsx's room list.
  // Scoping to "rooms the user's groups have created" is entirely RLS-enforced server-side (see
  // supabase/migrations/20260815000019_v2_study_rooms_group_visibility_and_join_gate.sql) - this
  // message does no client-side filtering of its own, same as GROUP_LIST_MINE.
  | { type: "STUDY_ROOM_LIST" }
  // v2 Task 13, fix round 1: routes to studyRoomApi.leaveRoom - StudyRoomPanel.tsx's leave
  // action sets left_at on the caller's own currently-open participant row. Throws on failure
  // (not signed in, update error) - same outer-catch convention as above.
  | { type: "STUDY_ROOM_LEAVE"; payload: { roomId: string } }
  // v2 Task 13, fix round 1: routes to studyRoomApi.listParticipants - seeds StudyRoomPanel.tsx's
  // presence list with a snapshot of who's currently in a room before subscribeToPresence's live
  // Realtime feed (which only ever delivers CHANGES from the moment of subscription onward, never
  // a backfill) takes over. subscribeToPresence itself is NOT a message - see studyRoomApi.ts's
  // header comment for why a live callback has no fit in this request/response surface.
  | { type: "STUDY_ROOM_LIST_PARTICIPANTS"; payload: { roomId: string } }
  // v2 Task 14: routes to producerTagApi.uploadTag - the sidepanel's recording flow, once
  // audioRecorder.ts's stopRecording() has resolved. audioBase64/mimeType exist ONLY because a raw
  // Blob cannot cross chrome.runtime.sendMessage under this codebase's default (JSON) message
  // serialization - see producerTagApi.ts's header comment. durationMs is
  // audioRecorder.ts's own getLastRecordingDurationMs() (the real elapsed recording time, clamped
  // to the cap), read by the panel right after stopRecording() resolves and forwarded here rather
  // than re-derived server-side (which would require decoding audio in a service worker - not
  // available). Throws on failure (not signed in, insert/upload error) - the outer handleMessage
  // try/catch turns that into ok:false, same convention as GROUP_CREATE/STUDY_ROOM_CREATE.
  | {
      type: "PRODUCER_TAG_UPLOAD";
      payload: { audioBase64: string; mimeType: string; durationMs: number };
    }
  // v2 Task 14: routes to producerTagApi.sendToFriend - the group-membership and tag-ownership
  // floors are both enforced entirely server-side (producer_tag_sends' INSERT policy, supabase/
  // migrations/20260815000021_v2_producer_tags_storage_and_send_floor.sql). Throws on failure -
  // same outer-catch convention as above.
  | { type: "PRODUCER_TAG_SEND_TO_FRIEND"; payload: { tagId: string; friendUserId: string } }
  // v2 Task 14: routes to producerTagApi.sendToRoom - inserts the producer_tag_sends row AND
  // broadcasts it live over Supabase Realtime to any currently-connected StudyRoomPanel (see
  // producerTagApi.ts's own comment on why this, unlike every other case here, has a live side
  // effect beyond the DB write - it still stays a plain request/response from this message's own
  // point of view, since the broadcast is fire-and-forget/best-effort inside sendToRoom() itself).
  // Throws on failure (the DB insert failing) - same outer-catch convention as above.
  | { type: "PRODUCER_TAG_SEND_TO_ROOM"; payload: { tagId: string; roomId: string } }
  // v2 Task 14: routes to producerTagApi.fetchIncomingProducerTagSends - the on-demand counterpart
  // to the background's alarm-driven poll (alarmHandlers.ts calls
  // producerTagApi.pollIncomingProducerTagSends directly, mirroring NUDGES_FETCH/
  // UNLOCK_REQUESTS_FETCH's identical split). Friend-delivery only, per this task's Part D - a
  // room send is never returned by this (see producerTagApi.ts's queryIncomingSince comment).
  | { type: "PRODUCER_TAG_SENDS_FETCH"; payload: { sinceTimestamp: number } }
  // v2 Task 14: routes to producerTagApi.fetchProducerTagById - StudyRoomPanel.tsx's lookup once a
  // live Realtime broadcast (subscribeToRoomProducerTags, called directly - see producerTagApi.ts's
  // header comment) names a tagId, resolving the audioUrl/durationMs needed to actually play it.
  // Plain CRUD read with no DOM coupling of its own (unlike the download/playback step that
  // follows it), so - unlike subscribeToRoomProducerTags/downloadTagAudio - this one IS
  // message-routed. Throws on a query error - same outer-catch convention as above; returns
  // { ok: true, tag: null } (not a throw) if the tag genuinely doesn't exist/isn't visible, mirroring
  // maybeSingle()'s own null-not-error distinction.
  | { type: "PRODUCER_TAG_FETCH_BY_ID"; payload: { tagId: string } };
