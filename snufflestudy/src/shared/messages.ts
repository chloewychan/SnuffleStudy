import type { CreateSessionInput, HistoryQuery, SessionState } from "../domain/session/sessionTypes";
import type { UserSettings } from "../domain/settings/userSettings";
import type { Task } from "../domain/tasks/taskTypes";
import type { FriendshipSettingsPatch } from "../infrastructure/backend/friendshipSettingsApi";
import type { FriendRequestKind } from "../domain/accountability/friendRequest";

export type ExtensionMessage =
  | { type: "SESSION_CREATE"; payload: CreateSessionInput }
  | { type: "SESSION_START"; payload: { sessionId: string } }
  | { type: "SESSION_PAUSE"; payload: { sessionId: string } }
  | { type: "SESSION_RESUME"; payload: { sessionId: string } }
  | { type: "SESSION_START_BREAK"; payload: { sessionId: string } }
  | { type: "SESSION_END_BREAK"; payload: { sessionId: string } }
  // `endRequestId` is an alternative to `passcode` on a hard-restricted session - when present,
  // messageRouter.ts's SESSION_END handler calls
  // friendRequestApi.isApprovedForSelf(endRequestId, "session_end", sessionId) instead of
  // checking a passcode; when absent, the passcode check runs unchanged. The two are mutually
  // exclusive in practice (EndSessionControl.tsx's passcode `<form>` never sets endRequestId, and
  // its "End session now" button never sets passcode), but nothing here enforces that at the type
  // level - the handler's own branch order (endRequestId checked first) is what decides.
  | {
      type: "SESSION_END";
      payload: { sessionId: string; reason?: string; passcode?: string; endRequestId?: string };
    }
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
  // Auth: OTP code-entry flow, not magic-link-click - see messageRouter.ts's AUTH_* cases for
  // why (a clickable link's redirect target would need a chrome-extension://<id>/... URL
  // registered with Supabase, and the extension ID differs between dev/unpacked and published
  // builds; signInWithOtp's email contains both a link and a 6-digit code, and only the code
  // path is used here).
  | { type: "AUTH_REQUEST_OTP"; payload: { email: string } }
  | { type: "AUTH_VERIFY_OTP"; payload: { email: string; token: string } }
  // AUTH_SET_PASSWORD is used both by SignInForm.tsx's mandatory create-account password step
  // (after a verified AUTH_VERIFY_OTP, before onSignedIn fires) and by AccountPage.tsx's
  // "set/change your password" action for an already-signed-in user (the recovery path for an
  // account with no password yet, and the normal way to change a password later) - both route
  // through supabase.auth.updateUser({ password }), which requires an existing session (see
  // messageRouter.ts's AUTH_SET_PASSWORD case). Response shape: { ok: boolean; error?: string }.
  // `currentPassword` is optional and only meaningful when the signed-in user's profile already
  // has `passwordSetAt` set - messageRouter.ts's handler requires and verifies it in that case
  // (via supabase.auth.signInWithPassword) before changing anything, and ignores it otherwise.
  // Omitted entirely by SignInForm.tsx's create-account caller (never has an existing password to
  // prove) and by AccountPage.tsx when passwordSetAt is null.
  | { type: "AUTH_SET_PASSWORD"; payload: { password: string; currentPassword?: string } }
  // Sign-in branch's "Sign in with a password" peer option (SignInForm.tsx) -
  // supabase.auth.signInWithPassword({ email, password }). Response shape mirrors
  // AUTH_VERIFY_OTP's: { ok: boolean; session?: <session>; error?: string }.
  | { type: "AUTH_SIGN_IN_PASSWORD"; payload: { email: string; password: string } }
  | { type: "AUTH_SIGN_OUT" }
  | { type: "AUTH_GET_SESSION" }
  // Routes to friendshipApi.generateInviteCode() over a direct pairwise friendships model (no
  // group concept) - "Invite a friend" is a single step, with no groupId param needed.
  | { type: "FRIEND_INVITE_GENERATE_CODE" }
  // Routes to friendshipApi.redeemInviteCode() -> redeem_invite_code(), which inserts a
  // friendships row directly between the two users. Instant connect on redemption, no
  // accept/decline step.
  | { type: "FRIEND_REDEEM_CODE"; payload: { code: string } }
  // Routes to friendshipApi.listMyFriends() - a flat list of every friend's user id (self
  // excluded).
  | { type: "FRIENDS_LIST" }
  // Routes to friendshipApi.removeFriend() - either party can unilaterally end the friendship
  // (enforced server-side via RLS: "either party can remove their friendship").
  | { type: "FRIEND_REMOVE"; payload: { friendUserId: string } }
  // Routes to sessionStatusSyncApi.fetchNewEventsForFriends via messageRouter.ts - used by both
  // alarmHandlers.ts's friend-poll alarm (indirectly, via a direct function call since that's
  // background-side code, not a message) and FriendGroupPanel.tsx (this message, since UI
  // components never import infrastructure/backend/* directly - see messageRouter.ts's
  // architecture note).
  | { type: "FRIEND_EVENTS_FETCH"; payload: { sinceTimestamp: number } }
  // Routes to nudgeApi.sendNudge - the toggle/cooldown rejection happens entirely server-side;
  // this handler is a thin pass-through, same convention as every other message case in
  // messageRouter.ts.
  //
  // The payload is a union - the catalog path (`messageId` against the fixed NUDGE_MESSAGES
  // list) is supported, and `vaultTextId` is additive, routing to a Nudge Vault written text
  // (nudgeVaultApi.ts) copied into the nudges.custom_body column at send time. Every caller that
  // sends `{ friendUserId, messageId }` keeps working unchanged.
  | { type: "NUDGE_SEND"; payload: { friendUserId: string } & ({ messageId: string } | { vaultTextId: string }) }
  // Routes to nudgeApi.fetchIncomingNudges - the on-demand counterpart to FRIEND_EVENTS_FETCH
  // above, used by FriendGroupPanel.tsx to render incoming nudges. The background's alarm-driven
  // poll (alarmHandlers.ts) calls nudgeApi.pollIncomingNudges directly rather than through this
  // message, mirroring FRIEND_EVENTS_FETCH/pollNewEventsForFriends's split.
  | { type: "NUDGES_FETCH"; payload: { sinceTimestamp: number } }
  // Routes to friendRequestApi.createRequest - the shared creation call for all three kinds
  // (site_unlock: RequestUnlockForm.tsx's requester side; site_temp_pass: LockedPage.tsx's
  // requester side; session_end: EndSessionControl.tsx's requester side). friendUserId is
  // omitted (undefined, not null) for site_unlock's group-wide/any-friend-can-resolve shape;
  // hostname is omitted for session_end, which isn't about any particular site. createRequest
  // throws on failure (not signed in, insert error) - the outer handleMessage try/catch turns
  // that into ok:false, same convention as FRIEND_INVITE_GENERATE_CODE/FRIEND_REDEEM_CODE.
  | {
      type: "FRIEND_REQUEST_CREATE";
      payload: {
        kind: FriendRequestKind;
        sessionId: string;
        friendUserId?: string;
        message?: string;
        hostname?: string;
      };
    }
  // Routes to friendRequestApi.resolveRequest - the friend (approve/deny) side, surfaced via the
  // persistent Nudges & Unlock Requests footer's approve/deny buttons (useIncomingActivity.ts),
  // for denying any kind or approving site_unlock/session_end. Approving site_temp_pass must use
  // FRIEND_REQUEST_APPROVE_TEMP_PASS instead - RLS's WITH CHECK clause enforces this
  // server-side regardless of what this message is sent for. "First responder wins" is enforced
  // server-side (RLS), not by this message or friendRequestApi.ts pre-checking anything
  // client-side - a second friend's resolve attempt on an already-resolved request throws,
  // surfaced the same ok:false way.
  | { type: "FRIEND_REQUEST_RESOLVE"; payload: { requestId: string; decision: "approved" | "denied" } }
  // Routes to friendRequestApi.approveTempPass - the one friend_requests mutation that does not
  // go through the shared FRIEND_REQUEST_RESOLVE path. Invokes the approve-temp-passcode Edge
  // Function (service_role, generates expires_at's TTL server-side).
  | { type: "FRIEND_REQUEST_APPROVE_TEMP_PASS"; payload: { requestId: string } }
  // Routes to friendRequestApi.claimApproval - LockedPage.tsx's requester-side auto-claim, fired
  // once the request's status is 'approved'. On {ok:true}, claimApproval itself also performs
  // the actual unlock (unlockHardBlockRuleForHostname + scheduleTempUnlockRelockAlarm), after a
  // fresh RLS-gated re-read of the row server-side (never trusts a client-supplied
  // hostname/expiry).
  | { type: "FRIEND_REQUEST_CLAIM_TEMP_PASS"; payload: { requestId: string } }
  // Routes to friendRequestApi.fetchRelevantRequests - the on-demand counterpart to the
  // background's alarm-driven poll (alarmHandlers.ts calls friendRequestApi.pollRelevantRequests
  // directly, mirroring FRIEND_EVENTS_FETCH/NUDGES_FETCH's identical split). A single query
  // covers every caller's needs (useIncomingActivity.ts, listing pending requests to review;
  // RequestUnlockForm.tsx/LockedPage.tsx/EndSessionControl.tsx checking their own request's
  // status): the requester's own requests (any status), requests assigned to the caller (any
  // status), and pending requests from anyone the caller is friends with when friend_user_id is
  // null - see friendRequestApi.ts's queryRelevantSince comment.
  | { type: "FRIEND_REQUESTS_FETCH"; payload: { sinceTimestamp: number } }
  // Routes to digestApi.fetchDigestForDate - the on-demand counterpart to the background's
  // alarm-driven poll (alarmHandlers.ts calls digestApi.pollNewDigests directly, mirroring
  // FRIEND_EVENTS_FETCH/NUDGES_FETCH/FRIEND_REQUESTS_FETCH's identical split). `date` is a
  // YYYY-MM-DD calendar date (daily_digests.digest_date's type); FriendGroupPanel.tsx picks
  // which date to request (see that file's own comment on why it defaults to yesterday).
  | { type: "DIGEST_FETCH"; payload: { date: string } }
  // Routes to friendshipSettingsApi.listMyFriendshipSettings() - the Friends section in
  // OptionsApp.tsx uses this to enumerate the current user's settings row toward each friend
  // (eight boolean columns).
  | { type: "FRIENDSHIP_SETTINGS_LIST" }
  // Routes to friendshipSettingsApi.updateFriendshipSettings() - a single field (or several) at
  // a time, keyed by which friend the change applies to. Throws on failure (e.g. no row exists
  // yet for that pair), which messageRouter.ts's outer handleMessage try/catch turns into
  // ok:false, same convention as FRIEND_INVITE_GENERATE_CODE/FRIEND_REDEEM_CODE/
  // FRIEND_REQUEST_CREATE.
  | {
      type: "FRIENDSHIP_SETTINGS_UPDATE";
      payload: { friendUserId: string; patch: FriendshipSettingsPatch };
    }
  // Routes to studyRoomApi.createRoom - StudyRoomPanel.tsx's create-room action. Plain one-shot
  // DB write with no live-callback or DOM/media coupling, so - unlike joinRoom/subscribeToPresence
  // (see studyRoomApi.ts's own header comment on why those two stay a direct, narrower exception)
  // - there's no reason for this to skip the same message-passing convention every other
  // *Api.ts write goes through. Throws on failure (not signed in, RLS-denied insert) - the outer
  // handleMessage try/catch turns that into ok:false, same convention as
  // FRIEND_INVITE_GENERATE_CODE.
  | { type: "STUDY_ROOM_CREATE"; payload: { name: string } }
  // Routes to studyRoomApi.listRooms - StudyRoomPanel.tsx's room list. Scoping to which rooms
  // the caller can see is entirely RLS-enforced server-side - this message does no client-side
  // filtering of its own, same as FRIENDS_LIST.
  | { type: "STUDY_ROOM_LIST" }
  // Routes to studyRoomApi.leaveRoom - StudyRoomPanel.tsx's leave action sets left_at on the
  // caller's own currently-open participant row. Throws on failure (not signed in, update
  // error) - same outer-catch convention as above.
  | { type: "STUDY_ROOM_LEAVE"; payload: { roomId: string } }
  // Routes to studyRoomApi.listParticipants - seeds StudyRoomPanel.tsx's presence list with a
  // snapshot of who's currently in a room before subscribeToPresence's live Realtime feed
  // (which only ever delivers CHANGES from the moment of subscription onward, never a backfill)
  // takes over. subscribeToPresence itself is NOT a message - see studyRoomApi.ts's header
  // comment for why a live callback has no fit in this request/response surface.
  | { type: "STUDY_ROOM_LIST_PARTICIPANTS"; payload: { roomId: string } }
  // Routes to studyRoomApi.archiveRoom - StudyRoomPanel.tsx's owner-only "Archive this room"
  // action. A soft delete (sets archived_at rather than a real DELETE, since
  // producer_tag_sends.recipient_room_id references study_rooms(id) with no ON DELETE CASCADE
  // anywhere in this schema). Throws on failure (not signed in, update error) - same
  // outer-catch convention as STUDY_ROOM_LEAVE above.
  | { type: "STUDY_ROOM_ARCHIVE"; payload: { roomId: string } }
  // Routes to studyRoomApi.addInvitee - StudyRoomPanel.tsx's owner-only "Manage access" section,
  // granting a friend future visibility/join access to a room. Owner-only is enforced entirely
  // server-side (study_room_invitees' "owner can manage invitees for their own room" RLS
  // policy), not by this message or studyRoomApi.ts pre-checking anything client-side - same
  // convention as STUDY_ROOM_ARCHIVE/STUDY_ROOM_CREATE. Throws on failure (not signed in, not
  // the room's owner, duplicate invite) - the outer handleMessage try/catch turns that into
  // ok:false.
  | { type: "STUDY_ROOM_INVITEE_ADD"; payload: { roomId: string; userId: string } }
  // Routes to studyRoomApi.removeInvitee - the same "Manage access" section's revoke action.
  // This only affects FUTURE visibility/join attempts - it does not touch
  // study_room_participants, so an invitee currently mid-call is not force-disconnected (see
  // studyRoomApi.ts's removeInvitee comment). Same outer-catch convention as above.
  | { type: "STUDY_ROOM_INVITEE_REMOVE"; payload: { roomId: string; userId: string } }
  // Routes to studyRoomApi.listInvitees - seeds the "Manage access" section's current invitee
  // list. Payload/response shapes mirror FRIENDS_LIST's pattern (a roomId in place of a friend
  // id). RLS (not this message) restricts who actually gets non-empty results back - same
  // trust-RLS convention as STUDY_ROOM_LIST.
  | { type: "STUDY_ROOM_INVITEES_LIST"; payload: { roomId: string } }
  // Routes to producerTagApi.uploadTag - the sidepanel's recording flow, once
  // audioRecorder.ts's stopRecording() has resolved. audioBase64/mimeType exist ONLY because a
  // raw Blob cannot cross chrome.runtime.sendMessage under this codebase's default (JSON)
  // message serialization - see producerTagApi.ts's header comment. durationMs is
  // audioRecorder.ts's own getLastRecordingDurationMs() (the real elapsed recording time,
  // clamped to the cap), read by the panel right after stopRecording() resolves and forwarded
  // here rather than re-derived server-side (which would require decoding audio in a service
  // worker - not available). Throws on failure (not signed in, insert/upload error) - the outer
  // handleMessage try/catch turns that into ok:false, same convention as
  // FRIEND_INVITE_GENERATE_CODE/STUDY_ROOM_CREATE.
  | {
      type: "PRODUCER_TAG_UPLOAD";
      payload: { audioBase64: string; mimeType: string; durationMs: number };
    }
  // Routes to producerTagApi.sendToFriend - the friendship and tag-ownership floors are both
  // enforced entirely server-side (producer_tag_sends' INSERT policy). Throws on failure - same
  // outer-catch convention as above.
  | { type: "PRODUCER_TAG_SEND_TO_FRIEND"; payload: { tagId: string; friendUserId: string } }
  // Routes to producerTagApi.sendToRoom - inserts the producer_tag_sends row AND broadcasts it
  // live over Supabase Realtime to any currently-connected StudyRoomPanel (see producerTagApi.ts's
  // own comment on why this, unlike every other case here, has a live side effect beyond the DB
  // write - it still stays a plain request/response from this message's own point of view,
  // since the broadcast is fire-and-forget/best-effort inside sendToRoom() itself). Throws on
  // failure (the DB insert failing) - same outer-catch convention as above.
  | { type: "PRODUCER_TAG_SEND_TO_ROOM"; payload: { tagId: string; roomId: string } }
  // Routes to producerTagApi.fetchIncomingProducerTagSends - the on-demand counterpart to the
  // background's alarm-driven poll (alarmHandlers.ts calls
  // producerTagApi.pollIncomingProducerTagSends directly, mirroring NUDGES_FETCH/
  // FRIEND_REQUESTS_FETCH's identical split). Friend-delivery only - a room send is never
  // returned by this (see producerTagApi.ts's queryIncomingSince comment).
  | { type: "PRODUCER_TAG_SENDS_FETCH"; payload: { sinceTimestamp: number } }
  // Routes to producerTagApi.fetchProducerTagById - StudyRoomPanel.tsx's lookup once a live
  // Realtime broadcast (subscribeToRoomProducerTags, called directly - see producerTagApi.ts's
  // header comment) names a tagId, resolving the audioUrl/durationMs needed to actually play it.
  // Plain CRUD read with no DOM coupling of its own (unlike the download/playback step that
  // follows it), so - unlike subscribeToRoomProducerTags/downloadTagAudio - this one IS
  // message-routed. Throws on a query error - same outer-catch convention as above; returns
  // { ok: true, tag: null } (not a throw) if the tag genuinely doesn't exist/isn't visible,
  // mirroring maybeSingle()'s own null-not-error distinction.
  | { type: "PRODUCER_TAG_FETCH_BY_ID"; payload: { tagId: string } }
  // "My vault" list - producerTagApi.listMine(), the owner's own non-deleted producer tags,
  // newest first. Distinct from PRODUCER_TAG_SENDS_FETCH above (incoming, from friends) - this
  // is "audio I've recorded and kept," for the Nudge Vault box.
  | { type: "PRODUCER_TAG_LIST_MINE" }
  // Routes to producerTagApi.softDelete - a past send referencing this tag keeps playing for its
  // recipient; this only removes it from the owner's own vault list and from future send
  // dropdowns. Throws on failure (not signed in, or the tag doesn't exist/isn't owned by the
  // caller) - same outer-catch convention as above.
  | { type: "PRODUCER_TAG_DELETE"; payload: { tagId: string } }
  // Routes to nudgeVaultApi.createVaultText - the Nudge Vault box's written-nudge textbox.
  // Throws on failure (not signed in, insert error, the body-length CHECK constraint) - same
  // outer-catch convention as above.
  | { type: "NUDGE_VAULT_TEXT_CREATE"; payload: { body: string } }
  // Routes to nudgeVaultApi.listMyVaultTexts - the Nudge Vault box's own written-nudge list, and
  // the source for every "pick a written nudge to send" dropdown elsewhere (Friends box, Study
  // Room footer).
  | { type: "NUDGE_VAULT_TEXT_LIST" }
  // Routes to nudgeVaultApi.deleteVaultText - the Nudge Vault box's per-item delete button.
  // Throws on failure (not signed in, or the text doesn't exist/isn't owned by the caller) -
  // same outer-catch convention as above. A nudge already sent from this vault text is
  // unaffected - its custom_body was copied at send time, not referenced live.
  | { type: "NUDGE_VAULT_TEXT_DELETE"; payload: { id: string } }
  // Routes to profileApi.getMyProfile() - BunnyTab.tsx's on-mount fetch. Returns profile: null
  // (not a throw, not an error) when the signed-in user has no profiles row yet - BunnyTab.tsx's
  // own stub-default fallback ("Snuffles"/"Hooman") handles that. Throws on a real failure (not
  // signed in, query error) - the outer handleMessage try/catch turns that into ok:false, same
  // convention as FRIENDSHIP_SETTINGS_LIST.
  | { type: "PROFILE_GET_MINE" }
  // Routes to profileApi.saveMyProfile() - BunnyTab.tsx's Save action. Upserts (see
  // profileApi.ts's own comment on why - no trigger pre-creates a profiles row the way
  // friendship_settings' does), so this also handles a user's very first save. Throws on
  // failure (not signed in, upsert error) - same outer-catch convention as above.
  | { type: "PROFILE_SAVE_MINE"; payload: { humanName?: string; bunnyName?: string } }
  // Routes to profileApi.fetchProfilesByIds() - shared/ui/useDisplayNames.ts's one fetch, reused
  // at every raw-userId display site (NudgeSendForm's friend picker, the Study Room footer's
  // participant tiles, incoming-request requester lines, LockedPage.tsx's friend picker,
  // AccountPage.tsx's friend list). Never throws (see profileApi.ts) - RLS (not this message,
  // not client-side filtering) is what actually restricts which of the requested userIds come
  // back: only the caller's own profile, or a friend's. An id with no matching profile (or no
  // human_name set) is simply omitted from the result, which useDisplayNames.ts's resolver
  // falls back to rendering as the raw id for.
  | { type: "PROFILES_FETCH_BY_IDS"; payload: { userIds: string[] } }
  // Routes to accountApi.deleteAccount() - AccountPage.tsx's "Delete account" action, gated
  // behind its own inline confirmation step before this message is ever sent. No payload - the
  // Edge Function this ultimately invokes (supabase/functions/delete-account/index.ts) resolves
  // the target user exclusively from the caller's own bearer token, never from anything this
  // message could carry. Throws on failure (Edge Function error, network failure) - the outer
  // handleMessage try/catch turns that into ok:false, same convention as
  // FRIEND_INVITE_GENERATE_CODE.
  | { type: "AUTH_DELETE_ACCOUNT" };
