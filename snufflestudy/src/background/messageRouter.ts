import type { ExtensionMessage } from "../shared/messages";
import type { Task } from "../domain/tasks/taskTypes";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { IndexedDbTaskRepository } from "../infrastructure/storage/taskRepository";
import * as machine from "../domain/session/sessionMachine";
import { validateCreateSessionInput } from "../domain/session/sessionValidation";
import { classifySite } from "../domain/sites/siteRules";
import { createHardBlockCredential, verifyPasscode } from "../domain/sites/hardBlockCredential";
import {
  scheduleSessionAlarm,
  cancelSessionAlarm,
  scheduleFriendPollAlarm,
  cancelFriendPollAlarm,
} from "../infrastructure/browser/alarmsApi";
import { showNotification } from "../infrastructure/browser/notificationsApi";
import {
  syncHardBlockRules,
  clearHardBlockRules,
  unlockHardBlockRuleForHostname,
} from "../infrastructure/browser/declarativeNetRequestApi";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as friendshipApi from "../infrastructure/backend/friendshipApi";
import * as sessionStatusSyncApi from "../infrastructure/backend/sessionStatusSyncApi";
import * as nudgeApi from "../infrastructure/backend/nudgeApi";
import * as friendRequestApi from "../infrastructure/backend/friendRequestApi";
import * as digestApi from "../infrastructure/backend/digestApi";
import * as friendshipSettingsApi from "../infrastructure/backend/friendshipSettingsApi";
import * as studyRoomApi from "../infrastructure/backend/studyRoomApi";
import * as producerTagApi from "../infrastructure/backend/producerTagApi";
import * as accountApi from "../infrastructure/backend/accountApi";
import * as profileApi from "../infrastructure/backend/profileApi";
import { currentFriendSyncUserId, hasAnyFriend, recordFriendStatusEvent } from "./friendSync";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();
const taskRepo = new IndexedDbTaskRepository();

// QA-discovered bug (v3.2): tasks used to have no account scoping at all - unlike
// currentFriendSyncUserId() (friendSync.ts), this is NOT gated on any settings toggle, since
// every signed-in user should have their own private task scope regardless of whether they've
// opted into friend-sync. Mirrors AUTH_GET_SESSION's own supabase.auth.getSession() call exactly
// - null means signed out, its own persistent task scope (see taskRepository.ts).
async function currentUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return null;
  return data.session.user.id;
}

// Starts the friend-poll alarm (v2 Task 6) when a session becomes active, but only if it's
// actually worth running: signed in + friend-sync enabled (currentFriendSyncUserId) AND has at
// least one friend (hasAnyFriend, v3.4 Task 2 - replaces isInAnyGroup()/group_memberships with a
// direct friendships existence check) - being opted in with no friend yet has nothing to poll
// for. Fire-and-forget/best-effort like recordFriendStatusEvent (see friendSync.ts): the
// friendship-existence check is a network call, so this must never block SESSION_START's own
// response on it.
function maybeStartFriendPoll(): void {
  currentFriendSyncUserId()
    .then(async (userId) => {
      if (!userId) return;
      if (await hasAnyFriend(userId)) {
        scheduleFriendPollAlarm();
      }
    })
    .catch((err) => console.error("Failed to evaluate friend-poll alarm eligibility", err));
}

function newId(): string {
  return crypto.randomUUID();
}

async function requireActiveSession(sessionId: string) {
  const session = await settingsRepo.getActiveSession();
  if (!session || session.id !== sessionId) {
    throw new Error(`No active session with id ${sessionId}`);
  }
  return session;
}

export async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender = {}
): Promise<unknown> {
  const now = Date.now();

  try {
    return await routeMessage(message, now, sender);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function routeMessage(
  message: ExtensionMessage,
  now: number,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case "SESSION_CREATE": {
      const validation = validateCreateSessionInput(message.payload);
      if (!validation.valid) return { ok: false, errors: validation.errors };
      const session = machine.createSession(message.payload, newId(), now);
      await settingsRepo.saveActiveSession(session);
      return { ok: true, session };
    }

    case "SESSION_START": {
      const session = await requireActiveSession(message.payload.sessionId);
      const started = machine.startSession(session, now);
      await settingsRepo.saveActiveSession(started);
      scheduleSessionAlarm(started.plannedEndAt!);
      if (started.restrictionMode === "hard") {
        await syncHardBlockRules(started.restrictedSites);
      }
      // v2 Task 10: goalText is StudySession.goal, already a local field on `started` - the
      // first time it's synced anywhere (session-start time is where the brief calls out goal
      // text as "available", so this is the one recordFriendStatusEvent call site that passes
      // it - see friendSync.ts's comment on why every other call site's shape is unchanged).
      recordFriendStatusEvent("SESSION_STARTED", started.id, "started a focus session", {
        goalText: started.goal,
      });
      maybeStartFriendPoll();
      return { ok: true, session: started };
    }

    case "SESSION_PAUSE": {
      const session = await requireActiveSession(message.payload.sessionId);
      const paused = machine.pauseSession(session, now);
      await settingsRepo.saveActiveSession(paused);
      cancelSessionAlarm();
      recordFriendStatusEvent("SESSION_PAUSED", paused.id, "paused their session");
      return { ok: true, session: paused };
    }

    case "SESSION_RESUME": {
      const session = await requireActiveSession(message.payload.sessionId);
      const resumed = machine.resumeSession(session, now);
      await settingsRepo.saveActiveSession(resumed);
      scheduleSessionAlarm(resumed.plannedEndAt!);
      recordFriendStatusEvent("SESSION_RESUMED", resumed.id, "resumed their session");
      return { ok: true, session: resumed };
    }

    case "SESSION_START_BREAK": {
      const session = await requireActiveSession(message.payload.sessionId);
      const onBreak = machine.startBreak(session, now);
      await settingsRepo.saveActiveSession(onBreak);
      scheduleSessionAlarm(onBreak.breakEndsAt!);
      recordFriendStatusEvent("SESSION_BREAK_STARTED", onBreak.id, "took a break");
      return { ok: true, session: onBreak };
    }

    case "SESSION_END_BREAK": {
      const session = await requireActiveSession(message.payload.sessionId);
      const focusing = machine.endBreak(session, now);
      await settingsRepo.saveActiveSession(focusing);
      scheduleSessionAlarm(focusing.plannedEndAt!);
      recordFriendStatusEvent("SESSION_BREAK_ENDED", focusing.id, "ended their break");
      return { ok: true, session: focusing };
    }

    case "SESSION_END": {
      // A SESSION_END message is always a user-initiated early/manual stop
      // (e.g. an "End Session" button). Natural, timer-driven completion is
      // handled entirely by alarmHandlers.ts, which calls completeSession
      // directly and never routes through this handler. So ending via
      // message is always an abandonment, regardless of the session's
      // current state (FOCUSING, PAUSED, BREAK, or SESSION_SETUP) —
      // abandonSession is valid from any non-terminal state.
      const session = await requireActiveSession(message.payload.sessionId);

      // Hard-restricted sessions are meant to resist being ended on a whim, so
      // "End session" is gated behind the same passcode as unlocking a hard-blocked
      // site (HARD_BLOCK_VERIFY_PASSCODE below) — reusing verifyPasscode means failed
      // attempts across both flows share the same rate-limit/lockout state, which is
      // intentional. If restrictionMode is "hard" but no credential was ever
      // configured (user picked hard mode without setting a passcode in Options),
      // there's nothing to verify against, so ending proceeds freely rather than
      // bricking the session until the timer naturally expires.
      if (session.restrictionMode === "hard") {
        // v3.3 Task 12: an approved temporary pass is an alternative to the permanent passcode,
        // never a replacement for it - checked first (and separately) so the passcode branch
        // below stays completely unchanged when endRequestId is absent. isApprovedForSelf does
        // its own fresh server-side read and explicitly checks requester_user_id against the
        // caller's own verified identity, not just row visibility - see that function's own
        // comment for exactly why that matters (RLS alone would let the resolving friend read
        // this row too, via resolved_by = auth.uid(), which is not the same thing as it being
        // THEIR pass to use).
        const endRequestId = message.payload.endRequestId;
        if (endRequestId) {
          // v3.4 Task 3: isApprovedForSelf now lives on friendRequestApi.ts (generalized from
          // sessionEndRequestApi.ts's identical function) and takes an explicit `kind` param -
          // everything else about this check (its own fresh server-side read, its explicit
          // requester_user_id comparison against the caller's own verified identity) is unchanged.
          const approved = await friendRequestApi.isApprovedForSelf(
            endRequestId,
            "session_end",
            session.id
          );
          if (!approved) {
            return {
              ok: false,
              error: "That temporary pass isn't valid for this session, or hasn't been approved yet.",
            };
          }
          // Falls through to the existing abandonSession logic below, skipping the passcode
          // check entirely.
        } else {
          const credential = await settingsRepo.getHardBlockCredential();
          if (credential) {
            const passcode = message.payload.passcode;
            if (!passcode) {
              return { ok: false, error: "Passcode required to end a hard-restricted session." };
            }
            const result = await verifyPasscode(credential, passcode, now);
            await settingsRepo.saveHardBlockCredential(result.credential);
            if (!result.success) {
              return {
                ok: false,
                error: "Incorrect passcode, or temporarily locked after repeated attempts.",
              };
            }
          }
        }
      }

      const ended = machine.abandonSession(session, now);
      await historyRepo.archive(ended);
      // Keep the ABANDONED session as the active session rather than clearing it immediately -
      // mirrors alarmHandlers.ts's COMPLETED handling (see its comment) so the UI gets a
      // chance to render an acknowledgment screen (AbandonedScreen) instead of snapping
      // straight back to idle/setup. It's cleared once the user acknowledges it via
      // SESSION_DISMISS_ABANDONED below.
      await settingsRepo.saveActiveSession(ended);
      cancelSessionAlarm();
      // This is the only path that produces an abandoned session (see this case's own comment
      // above) - the session is ending, so stop polling for friend events same as natural
      // completion does (alarmHandlers.ts). Recording SESSION_ABANDONED itself is
      // fire-and-forget/gated (friendSync.ts).
      cancelFriendPollAlarm();
      recordFriendStatusEvent("SESSION_ABANDONED", ended.id, "ended their session early");
      await clearHardBlockRules();
      showNotification("session-abandoned", "Session ended", `"${session.goal}" was ended early.`);
      return { ok: true, session: ended };
    }

    case "SESSION_DISMISS_COMPLETED": {
      const session = await requireActiveSession(message.payload.sessionId);
      if (session.state !== "COMPLETED") {
        return { ok: false, error: `Cannot dismiss a session in state ${session.state}` };
      }
      await settingsRepo.saveActiveSession(null);
      // Safety net in case the friend-poll alarm wasn't already cleared (e.g. a service-worker
      // restart between natural completion and this dismiss) - cancelling an alarm that's
      // already stopped is a harmless no-op.
      cancelFriendPollAlarm();
      return { ok: true };
    }

    case "SESSION_DISMISS_ABANDONED": {
      const session = await requireActiveSession(message.payload.sessionId);
      if (session.state !== "ABANDONED") {
        return { ok: false, error: `Cannot dismiss a session in state ${session.state}` };
      }
      await settingsRepo.saveActiveSession(null);
      // Same safety-net rationale as SESSION_DISMISS_COMPLETED above.
      cancelFriendPollAlarm();
      return { ok: true };
    }

    case "SESSION_GET_ACTIVE": {
      return { ok: true, session: await settingsRepo.getActiveSession() };
    }

    case "SITE_STATUS_REQUEST": {
      const session = await settingsRepo.getActiveSession();
      if (!session) return { ok: true, classification: "UNKNOWN" };
      return { ok: true, classification: classifySite(session, message.payload.hostname) };
    }

    case "DISTRACTION_ATTEMPT": {
      const session = await requireActiveSession(message.payload.sessionId);
      const updated = machine.recordDistractionAttempt(machine.warnSession(session));
      await settingsRepo.saveActiveSession(updated);
      await historyRepo.recordEvent({
        id: newId(),
        sessionId: session.id,
        type: "DISTRACTION_ATTEMPT",
        occurredAt: now,
        hostname: message.payload.hostname,
      });
      // displayLabel is deliberately generic - never the hostname the distraction event itself
      // carries (see session_status_events' display_label column comment in the schema
      // migration: "never the raw hostname unless the sender explicitly opted in"). v2 Task 10
      // builds that opt-in: the REAL hostname is now written to the new, separate `hostname`
      // column (never into displayLabel) - read-side visibility is gated entirely by
      // share_current_domain via friend_has_granted_domain_visibility/fetch_friend_event_details
      // (supabase/migrations/20260815000012_v2_privacy_controls.sql), not by withholding it here.
      recordFriendStatusEvent("DISTRACTION_ATTEMPT", session.id, "got distracted", {
        hostname: message.payload.hostname,
      });
      return { ok: true, session: updated };
    }

    case "MARK_SITE_STUDY_RELATED": {
      // v2 Task 9, Part B: this is one of the two resolution paths for an active distraction
      // warning (the other is RETURN_TO_WORK_CLOSE_TAB below) - see SnufflesOverlay.tsx's
      // handleMarkStudyRelated. sessionMachine.recordRecovery existed since v1 but was never
      // called from anywhere (verified via grep - zero call sites outside sessionMachine.ts's
      // own tests), which left RECOVERY permanently unreachable and recoveryRate fabricated
      // for every user - a real gap this task's DigestSummary.recoveryRate field would
      // otherwise just report as 0 forever. Only counts as a genuine recovery if there was
      // actually an active warning to recover from (interventionLevel !== "none" at the time),
      // so routinely pre-allowlisting a site with no prior warning doesn't inflate the count.
      const session = await requireActiveSession(message.payload.sessionId);
      const hadActiveWarning = session.interventionLevel !== "none";
      const withAllowedSite = {
        ...session,
        allowedSites: [...session.allowedSites, message.payload.hostname],
      };
      const updated = hadActiveWarning ? machine.recordRecovery(withAllowedSite) : withAllowedSite;
      await settingsRepo.saveActiveSession(updated);
      await historyRepo.recordEvent({
        id: newId(),
        sessionId: session.id,
        type: "SITE_MARKED_STUDY_RELATED",
        occurredAt: now,
        hostname: message.payload.hostname,
      });
      if (hadActiveWarning) {
        // Dual-write, mirroring DISTRACTION_ATTEMPT's existing local+remote pattern above: a
        // local historyRepo event (History/Review consistency) plus a best-effort/gated remote
        // sync (friendSync.ts). displayLabel is generic, never the hostname - same convention
        // DISTRACTION_ATTEMPT's own comment documents.
        await historyRepo.recordEvent({
          id: newId(),
          sessionId: session.id,
          type: "RECOVERY",
          occurredAt: now,
          hostname: message.payload.hostname,
        });
        recordFriendStatusEvent("RECOVERY", session.id, "got back on track");
      }
      return { ok: true, session: updated };
    }

    case "RETURN_TO_WORK_CLOSE_TAB": {
      // Only reachable from the content-script overlay's "Return to work" button, and only
      // when the restricted site was opened fresh (no document.referrer) - the tab has
      // nothing to navigate back to, so closing it is the only way to actually return the
      // user to their prior context (see SnufflesOverlay.tsx for the referrer branch).
      //
      // v2 Task 9, Part B: this message carries no sessionId (see shared/messages.ts - its
      // payload is empty), so recordRecovery below reads the active session directly via
      // settingsRepo rather than requireActiveSession. Same "only counts if there was an
      // active warning" guard as MARK_SITE_STUDY_RELATED above - see that case's comment for
      // the full rationale (recordRecovery was previously wired up nowhere at all).
      const session = await settingsRepo.getActiveSession();
      if (session && session.interventionLevel !== "none") {
        const updated = machine.recordRecovery(session);
        await settingsRepo.saveActiveSession(updated);
        await historyRepo.recordEvent({
          id: newId(),
          sessionId: session.id,
          type: "RECOVERY",
          occurredAt: now,
        });
        recordFriendStatusEvent("RECOVERY", session.id, "got back on track");
      }

      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        return { ok: false, error: "No tab to close." };
      }
      await chrome.tabs.remove(tabId);
      return { ok: true };
    }

    case "HARD_BLOCK_SET_PASSCODE": {
      // Changing an *existing* passcode requires proving knowledge of the current one first
      // (mirrors the architecture overview's "extending/removing hard restrictions requires
      // re-entering the passcode" rule) - otherwise anyone with access to Options could silently
      // replace the passcode a friend was entrusted with, defeating both the End Session gate
      // and the hard-block site-unlock gate. First-time setup (no existing credential) has
      // nothing to verify against, so it proceeds unconditionally, same as before.
      const existing = await settingsRepo.getHardBlockCredential();
      if (existing) {
        const oldPasscode = message.payload.oldPasscode;
        if (!oldPasscode) {
          return { ok: false, error: "Current passcode required to set a new one." };
        }
        const result = await verifyPasscode(existing, oldPasscode, now);
        await settingsRepo.saveHardBlockCredential(result.credential);
        if (!result.success) {
          return {
            ok: false,
            error: "Incorrect current passcode, or temporarily locked after repeated attempts.",
          };
        }
      }
      const credential = await createHardBlockCredential(message.payload.passcode);
      await settingsRepo.saveHardBlockCredential(credential);
      return { ok: true };
    }

    case "HARD_BLOCK_VERIFY_PASSCODE": {
      const credential = await settingsRepo.getHardBlockCredential();
      if (!credential) return { ok: false, error: "No passcode configured." };
      const result = await verifyPasscode(credential, message.payload.passcode, now);
      await settingsRepo.saveHardBlockCredential(result.credential);
      if (result.success) {
        // A correct entry unlocks this specific site for the remainder of the session (per the
        // architecture overview) - remove only this hostname's DNR redirect rule so the browser
        // stops immediately re-catching the LockedPage.tsx redirect back to it. Other
        // hard-restricted hostnames' rules are untouched and keep blocking.
        await unlockHardBlockRuleForHostname(message.payload.hostname);
      }
      return { ok: result.success };
    }

    case "SETTINGS_GET": {
      return { ok: true, settings: await settingsRepo.getSettings() };
    }

    case "SETTINGS_SAVE": {
      await settingsRepo.saveSettings(message.payload);
      return { ok: true };
    }

    case "SESSION_LIST_HISTORY": {
      return { ok: true, sessions: await historyRepo.listHistory(message.payload) };
    }

    case "SESSION_COUNT_BY_STATE": {
      return { ok: true, count: await historyRepo.countByState(message.payload.state) };
    }

    case "SESSION_LIST_EVENTS": {
      return { ok: true, events: await historyRepo.listEvents(message.payload.sessionId) };
    }

    case "TASK_CREATE": {
      const task: Task = {
        id: newId(),
        userId: await currentUserId(),
        title: message.payload.title,
        createdAt: now,
      };
      await taskRepo.create(task);
      return { ok: true, task };
    }

    case "TASK_UPDATE": {
      await taskRepo.update(message.payload);
      return { ok: true, task: message.payload };
    }

    case "TASK_DELETE": {
      await taskRepo.delete(message.payload.taskId);
      return { ok: true };
    }

    case "TASK_LIST": {
      return { ok: true, tasks: await taskRepo.list(await currentUserId()) };
    }

    case "AUTH_REQUEST_OTP": {
      const { error } = await supabase.auth.signInWithOtp({ email: message.payload.email });
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    case "AUTH_VERIFY_OTP": {
      // type: "email" selects the OTP-code verification path (not the magic-link path) - see
      // shared/messages.ts's comment on AUTH_REQUEST_OTP for why only the code path is used.
      const { data, error } = await supabase.auth.verifyOtp({
        email: message.payload.email,
        token: message.payload.token,
        type: "email",
      });
      if (error) return { ok: false, error: error.message };
      return { ok: true, session: data.session };
    }

    // v3.3 Task 14: mandatory create-account password step (SignInForm.tsx, after a verified
    // AUTH_VERIFY_OTP) and AccountPage.tsx's "set/change your password" action both route here.
    // updateUser({ password }) requires an existing session - both call sites only ever invoke
    // this while already signed in (a freshly-verified OTP session, or an already-signed-in
    // AccountPage user), matching supabase-js's own requirement (confirmed against the installed
    // @supabase/auth-js 2.112.3 .d.ts: `updateUser(attributes: UserAttributes, options?)` where
    // UserAttributes.password is `string | undefined`, returning `UserResponse` -
    // `{ data: { user }, error: null } | { data: null, error: AuthError }`).
    // v3.4 Task 6: Verify the CURRENT password before changing it, but only when one already
    // exists to verify against - profiles.password_set_at is the durable, server-side signal for
    // that (the client can't reliably infer "does this account already have a password" from the
    // Supabase session object alone). getMyProfile() throws if not signed in - both call sites
    // (this and Task 7's create-account completion step) only ever invoke this while already
    // signed in, same precondition the pre-existing comment above already documents.
    case "AUTH_SET_PASSWORD": {
      const profile = await profileApi.getMyProfile();
      if (profile?.passwordSetAt) {
        const currentPassword = message.payload.currentPassword;
        if (!currentPassword) {
          return { ok: false, error: "Current password is required." };
        }
        const { data: sessionData } = await supabase.auth.getSession();
        const email = sessionData.session?.user.email;
        if (!email) {
          return { ok: false, error: "Could not verify your current password." };
        }
        // Reuses the exact same signInWithPassword call AUTH_SIGN_IN_PASSWORD already makes - a
        // failed attempt here is exactly a wrong-password AuthError, same shape as that case
        // already handles (see this file's AUTH_SIGN_IN_PASSWORD comment for the confirmed
        // supabase-js return shape). This does not create a NEW session or replace the caller's
        // current one - it's a pure verification call; whatever error/success it returns is read
        // and discarded, never stored.
        const { error: verifyError } = await supabase.auth.signInWithPassword({
          email,
          password: currentPassword,
        });
        if (verifyError) {
          return { ok: false, error: "Current password is incorrect." };
        }
      }
      const { error } = await supabase.auth.updateUser({ password: message.payload.password });
      if (error) return { ok: false, error: error.message };
      await profileApi.markPasswordSet();
      return { ok: true };
    }

    // v3.3 Task 14: the sign-in branch's "Sign in with a password" peer option (SignInForm.tsx) -
    // confirmed against the installed @supabase/auth-js 2.112.3 .d.ts: `signInWithPassword(
    // credentials: SignInWithPasswordCredentials): Promise<AuthTokenResponsePassword>`, where
    // SignInWithPasswordCredentials accepts `{ email, password }` and AuthTokenResponsePassword
    // resolves to `{ data: { user, session, weakPassword? }, error: null } | { data: {...:
    // null}, error: AuthError }` - same `data.session` shape AUTH_VERIFY_OTP already returns.
    case "AUTH_SIGN_IN_PASSWORD": {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: message.payload.email,
        password: message.payload.password,
      });
      if (error) return { ok: false, error: error.message };
      return { ok: true, session: data.session };
    }

    case "AUTH_SIGN_OUT": {
      const { error } = await supabase.auth.signOut();
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    case "AUTH_GET_SESSION": {
      const { data, error } = await supabase.auth.getSession();
      if (error) return { ok: false, error: error.message };
      return { ok: true, session: data.session };
    }

    case "FRIEND_INVITE_GENERATE_CODE": {
      const inviteCode = await friendshipApi.generateInviteCode();
      return { ok: true, inviteCode };
    }

    case "FRIEND_REDEEM_CODE": {
      const friendship = await friendshipApi.redeemInviteCode(message.payload.code);
      return { ok: true, friendship };
    }

    case "FRIENDS_LIST": {
      const friendIds = await friendshipApi.listMyFriends();
      return { ok: true, friendIds };
    }

    case "FRIEND_REMOVE": {
      // removeFriend throws (not signed in, Postgres error, or "You aren't friends with this
      // user." when the delete matched zero rows) rather than returning ok:false - the outer
      // handleMessage try/catch (top of this file) turns that into { ok: false, error }, same
      // convention as FRIEND_INVITE_GENERATE_CODE/FRIEND_REDEEM_CODE above.
      await friendshipApi.removeFriend(message.payload.friendUserId);
      return { ok: true };
    }

    case "FRIEND_EVENTS_FETCH": {
      // fetchNewEventsForFriends already degrades to [] (never throws) when signed out - see
      // sessionStatusSyncApi.ts - so FriendGroupPanel.tsx always gets an ok:true response, even
      // with nothing to show.
      const events = await sessionStatusSyncApi.fetchNewEventsForFriends(
        message.payload.sinceTimestamp
      );
      return { ok: true, events };
    }

    case "NUDGE_SEND": {
      // sendNudge already translates a server-side (RLS/can_send_nudge()) rejection into
      // { ok: false, error } - see nudgeApi.ts - never throws for that case, so this stays a
      // thin pass-through like every other case here.
      return nudgeApi.sendNudge(message.payload.friendUserId, message.payload.messageId);
    }

    case "NUDGES_FETCH": {
      // fetchIncomingNudges already degrades to [] (never throws) when signed out or on a
      // transient failure - see nudgeApi.ts - so FriendGroupPanel.tsx always gets an ok:true
      // response, even with nothing to show.
      const nudges = await nudgeApi.fetchIncomingNudges(message.payload.sinceTimestamp);
      return { ok: true, nudges };
    }

    case "FRIEND_REQUEST_CREATE": {
      // createRequest throws (not signed in, insert error) rather than returning ok:false - the
      // outer handleMessage try/catch (top of this file) turns that into { ok: false, error },
      // same convention as GROUP_CREATE/GROUP_JOIN above. One shared call for all three kinds -
      // replaces UNLOCK_REQUEST_CREATE/TEMP_PASSCODE_CREATE/SESSION_END_REQUEST_CREATE.
      const request = await friendRequestApi.createRequest(message.payload.kind, message.payload);
      return { ok: true, request };
    }

    case "FRIEND_REQUEST_RESOLVE": {
      // resolveRequest throws on a denied/failed resolve (including the "first responder wins"
      // race, and Decision 3's RLS-enforced exclusion of plain-client site_temp_pass approval -
      // see friendRequestApi.ts's own comment) - same outer-catch convention as above.
      // Applying an approved site_unlock/site_temp_pass to the requester's own active
      // session/hard-block rules does NOT happen here: this message runs on the RESOLVING
      // FRIEND's device, which has no access to the requester's local state - that side effect
      // only happens on the requester's own device, via alarmHandlers.ts's friend-poll alarm
      // noticing their own request resolved (pollFriendRequestUpdates).
      await friendRequestApi.resolveRequest(message.payload.requestId, message.payload.decision);
      return { ok: true };
    }

    case "FRIEND_REQUEST_APPROVE_TEMP_PASS": {
      // approveTempPass throws on failure (not the assigned friend, already resolved, Edge
      // Function error) - same outer-catch convention as above. Decision 3: the only
      // friend_requests approval path for kind = 'site_temp_pass' - RLS's WITH CHECK excludes
      // this transition from FRIEND_REQUEST_RESOLVE's plain client UPDATE entirely.
      const result = await friendRequestApi.approveTempPass(message.payload.requestId);
      return { ok: true, ...result };
    }

    case "FRIEND_REQUEST_CLAIM_TEMP_PASS": {
      // v3.3 Task 10: replaces TEMP_PASSCODE_REDEEM - there is no code to submit anymore.
      // claimApproval never throws (see friendRequestApi.ts) - it resolves to { ok: false } for
      // every failure path (RLS-denied/missing row, expired, network/invoke error), and on
      // success has already performed the actual local unlock
      // (unlockHardBlockRuleForHostname + scheduleTempUnlockRelockAlarm) itself. This case is a
      // thin pass-through, same convention as HARD_BLOCK_VERIFY_PASSCODE.
      const result = await friendRequestApi.claimApproval(message.payload.requestId);
      return result;
    }

    case "FRIEND_REQUESTS_FETCH": {
      // fetchRelevantRequests already degrades to [] (never throws) when signed out or on a
      // transient failure - see friendRequestApi.ts - so FriendRequestPanel.tsx/
      // RequestUnlockForm.tsx/LockedPage.tsx/EndSessionControl.tsx always get an ok:true
      // response, even with nothing to show. Replaces UNLOCK_REQUESTS_FETCH/
      // TEMP_PASSCODE_REQUESTS_FETCH/SESSION_END_REQUESTS_FETCH.
      const requests = await friendRequestApi.fetchRelevantRequests(
        message.payload.sinceTimestamp
      );
      return { ok: true, requests };
    }

    case "DIGEST_FETCH": {
      // fetchDigestForDate already degrades to [] (never throws) when signed out or on a
      // transient failure - see digestApi.ts - so FriendGroupPanel.tsx always gets an ok:true
      // response, even with nothing to show for that date.
      const digests = await digestApi.fetchDigestForDate(message.payload.date);
      return { ok: true, digests };
    }

    case "FRIENDSHIP_SETTINGS_LIST": {
      // listMyFriendshipSettings throws (not signed in, query error) rather than returning
      // ok:false - the outer handleMessage try/catch turns that into { ok: false, error }, same
      // convention as GROUP_CREATE/GROUP_JOIN/FRIEND_REQUEST_CREATE above.
      const settings = await friendshipSettingsApi.listMyFriendshipSettings();
      return { ok: true, settings };
    }

    case "FRIENDSHIP_SETTINGS_UPDATE": {
      // updateFriendshipSettings throws on failure (not signed in, no row exists for this
      // friend yet, update error) - same outer-catch convention as above.
      const settings = await friendshipSettingsApi.updateFriendshipSettings(
        message.payload.friendUserId,
        message.payload.patch
      );
      return { ok: true, settings };
    }

    case "STUDY_ROOM_CREATE": {
      // createRoom throws on failure (not signed in, RLS-denied insert) - outer handleMessage
      // try/catch turns that into ok:false, same convention as GROUP_CREATE.
      const room = await studyRoomApi.createRoom(message.payload.name);
      return { ok: true, room };
    }

    case "STUDY_ROOM_LIST": {
      const rooms = await studyRoomApi.listRooms();
      return { ok: true, rooms };
    }

    case "STUDY_ROOM_LEAVE": {
      await studyRoomApi.leaveRoom(message.payload.roomId);
      return { ok: true };
    }

    case "STUDY_ROOM_LIST_PARTICIPANTS": {
      const participants = await studyRoomApi.listParticipants(message.payload.roomId);
      return { ok: true, participants };
    }

    case "STUDY_ROOM_ARCHIVE": {
      // archiveRoom throws on failure (not signed in, update error) - outer handleMessage
      // try/catch turns that into ok:false, same convention as STUDY_ROOM_LEAVE.
      await studyRoomApi.archiveRoom(message.payload.roomId);
      return { ok: true };
    }

    case "STUDY_ROOM_INVITEE_ADD": {
      await studyRoomApi.addInvitee(message.payload.roomId, message.payload.userId);
      return { ok: true };
    }

    case "STUDY_ROOM_INVITEE_REMOVE": {
      await studyRoomApi.removeInvitee(message.payload.roomId, message.payload.userId);
      return { ok: true };
    }

    case "STUDY_ROOM_INVITEES_LIST": {
      const invitees = await studyRoomApi.listInvitees(message.payload.roomId);
      return { ok: true, invitees };
    }

    case "PRODUCER_TAG_UPLOAD": {
      // The Blob<->base64 round trip lives here (background context has atob/Blob/Uint8Array but
      // no DOM) - see producerTagApi.ts's header comment and blobFromBase64's own comment for why
      // this exists at all.
      const blob = producerTagApi.blobFromBase64(message.payload.audioBase64, message.payload.mimeType);
      const tag = await producerTagApi.uploadTag(blob, message.payload.durationMs);
      return { ok: true, tag };
    }

    case "PRODUCER_TAG_SEND_TO_FRIEND": {
      await producerTagApi.sendToFriend(message.payload.tagId, message.payload.friendUserId);
      return { ok: true };
    }

    case "PRODUCER_TAG_SEND_TO_ROOM": {
      await producerTagApi.sendToRoom(message.payload.tagId, message.payload.roomId);
      return { ok: true };
    }

    case "PRODUCER_TAG_SENDS_FETCH": {
      // fetchIncomingProducerTagSends already degrades to [] (never throws) when signed out or on
      // a transient failure - see producerTagApi.ts - so FriendGroupPanel.tsx always gets an
      // ok:true response, even with nothing to show.
      const sends = await producerTagApi.fetchIncomingProducerTagSends(message.payload.sinceTimestamp);
      return { ok: true, sends };
    }

    case "PRODUCER_TAG_FETCH_BY_ID": {
      const tag = await producerTagApi.fetchProducerTagById(message.payload.tagId);
      return { ok: true, tag };
    }

    case "PROFILE_GET_MINE": {
      // getMyProfile throws (not signed in, query error) rather than returning ok:false - the
      // outer handleMessage try/catch turns that into { ok: false, error }, same convention as
      // FRIENDSHIP_SETTINGS_LIST above. profile: null is a normal, non-error result (no profiles
      // row yet) - see profileApi.ts's own comment.
      const profile = await profileApi.getMyProfile();
      return { ok: true, profile };
    }

    case "PROFILE_SAVE_MINE": {
      // saveMyProfile throws on failure (not signed in, upsert error) - same outer-catch
      // convention as above.
      const profile = await profileApi.saveMyProfile(message.payload);
      return { ok: true, profile };
    }

    case "PROFILES_FETCH_BY_IDS": {
      // fetchProfilesByIds already degrades to [] (never throws) on any failure - see
      // profileApi.ts - so useDisplayNames.ts always gets an ok:true response, even with nothing
      // to show.
      const profiles = await profileApi.fetchProfilesByIds(message.payload.userIds);
      return { ok: true, profiles };
    }

    case "AUTH_DELETE_ACCOUNT": {
      // Captured BEFORE deleteAccount() clears the local session - taskRepo.deleteAllForUser
      // needs the id of the account that's about to no longer exist. accountApi.deleteAccount()
      // is unaffected by (and unaware of) this local read: it resolves the caller's identity
      // itself, from the request's own bearer token.
      const userId = await currentUserId();
      await accountApi.deleteAccount();
      // QA-discovered bug (v3.2): tasks live in local IndexedDB, not Supabase - nothing
      // server-side (the delete-account Edge Function/delete_account_data SQL function) can ever
      // reach them, so this device-local cleanup has to happen here. Best-effort: the account is
      // already deleted server-side by this point regardless of whether this succeeds, so a
      // failure here is logged, not surfaced as if the whole deletion failed.
      if (userId) {
        try {
          await taskRepo.deleteAllForUser(userId);
        } catch (err) {
          console.error("Failed to clear local tasks after account deletion", err);
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type" };
  }
}
