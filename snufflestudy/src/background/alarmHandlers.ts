import {
  isSessionAlarm,
  isFriendPollAlarm,
  cancelFriendPollAlarm,
  isTempUnlockRelockAlarm,
  hostnameFromTempUnlockRelockAlarm,
  scheduleTempUnlockRelockAlarm,
} from "../infrastructure/browser/alarmsApi";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { IndexedDbTaskRepository } from "../infrastructure/storage/taskRepository";
import * as machine from "../domain/session/sessionMachine";
import { showNotification } from "../infrastructure/browser/notificationsApi";
import {
  clearHardBlockRules,
  lockHardBlockRuleForHostname,
  unlockHardBlockRuleForHostname,
} from "../infrastructure/browser/declarativeNetRequestApi";
import { pollNewEventsForFriends } from "../infrastructure/backend/sessionStatusSyncApi";
import { pollIncomingNudges } from "../infrastructure/backend/nudgeApi";
import { pollRelevantRequests } from "../infrastructure/backend/friendRequestApi";
import type { FriendRequest } from "../domain/accountability/friendRequest";
import { pollNewDigests } from "../infrastructure/backend/digestApi";
import { pollIncomingProducerTagSends } from "../infrastructure/backend/producerTagApi";
import * as profileApi from "../infrastructure/backend/profileApi";
import { supabase } from "../infrastructure/backend/supabaseClient";
import { nudgeMessageText } from "../domain/accountability/nudgeMessages";
import { isWithinQuietHours } from "../domain/settings/userSettings";
import {
  getLastFriendPollAt,
  setLastFriendPollAt,
  getLastNudgePollAt,
  setLastNudgePollAt,
  getLastFriendRequestPollAt,
  setLastFriendRequestPollAt,
  getLastDigestPollAt,
  setLastDigestPollAt,
  getLastProducerTagPollAt,
  setLastProducerTagPollAt,
  getLastFriendConnectionPollAt,
  setLastFriendConnectionPollAt,
} from "../infrastructure/storage/friendPollState";
import { currentFriendSyncUserId, hasAnyFriend, recordFriendStatusEvent } from "./friendSync";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();
const taskRepo = new IndexedDbTaskRepository();

// A naturally-completing session never routes back through recordFriendStatusEvent's usual
// caller (messageRouter.ts) - this file's handleAlarm is the only place SESSION_COMPLETED can
// be recorded from (v1 Task 4's markBreakdownItemCompleted needed the exact same relocation for
// the exact same reason - see this file's own comment on that function). Look-back window for
// the very first poll of either stream, before any cursor (getLastFriendPollAt/
// getLastNudgePollAt) has ever been persisted for it - 5 minutes is comfortably wider than one
// alarm interval (1 minute) so an event/nudge from just before this device started polling still
// surfaces once, without dredging up an unbounded historical backlog. Shared between
// pollSessionEventUpdates and pollNudgeUpdates below since both cursors have the identical
// "never persisted yet" bootstrap problem.
const FIRST_POLL_LOOKBACK_MS = 5 * 60 * 1000;

// Polls session_status_events for new friend activity and shows a chrome.notifications toast for
// each (per docs/Draft1_Architecture_Overview.md's Phase 1 "polling" friend-event delivery plan).
// Split out from handleFriendPollAlarm (v2 Task 7) so this stream's own try/catch and cursor
// (friendPollState.ts's getLastFriendPollAt/setLastFriendPollAt) stay fully independent of
// pollNudgeUpdates below - the two are logically separate streams delivered by the same alarm
// tick, and a failure in one must never block or corrupt the other's progress.
async function pollSessionEventUpdates(): Promise<void> {
  try {
    const now = Date.now();
    const since = (await getLastFriendPollAt()) ?? now - FIRST_POLL_LOOKBACK_MS;
    const result = await pollNewEventsForFriends(since);
    if (!result.ok) {
      // The fetch itself failed (network/query/auth error - distinct from "genuinely no new
      // events", see pollNewEventsForFriends's own comment). Leave the persisted cursor where it
      // was so the next tick retries this exact window, rather than silently advancing past
      // friend events that occurred during the outage (fix round 1 - previously this branch
      // didn't exist, so any silent failure still advanced the cursor to `now`, permanently
      // losing whatever happened during the outage window).
      return;
    }
    for (const event of result.events) {
      showNotification(`friend-event-${event.id}`, "Friend activity", event.displayLabel);
    }
    await setLastFriendPollAt(now);
  } catch (err) {
    console.error("Failed to poll friend session events", err);
  }
}

// Polls nudges for new incoming nudges addressed to the current user, and shows a
// chrome.notifications toast for each (v2 Task 7, reusing Task 6's alarm/notification path per
// this task's brief - "not building a parallel one"). Notification content deliberately differs
// from pollSessionEventUpdates's ("Nudge from a friend" + the actual message text and sender,
// rather than "Friend activity" + a generic displayLabel) so the two never read as
// indistinguishable generic copy. Same "only advance the cursor on confirmed success" discipline
// as pollSessionEventUpdates, using its own independent cursor
// (getLastNudgePollAt/setLastNudgePollAt) so a failure fetching nudges never affects, and is
// never affected by, the session-events cursor above.
// v2 Task 10, Part C: `liveNudgesNotificationsEnabled`/quietHours gate ONLY whether a toast is
// shown - the fetch/cursor-advancement above (and below) runs exactly as before, unaffected,
// consistent with how this alarm's other streams already separate "did the fetch succeed" from
// "should the user be shown something" (see pollFriendRequestUpdates' pending-vs-own-request
// branching for the same kind of separation). Computed once per tick from the current settings
// snapshot - deliberately NOT a per-nudge check, since quiet-hours status can't meaningfully
// change within the few milliseconds it takes to loop over one poll's results.
async function pollNudgeUpdates(): Promise<void> {
  try {
    const now = Date.now();
    const since = (await getLastNudgePollAt()) ?? now - FIRST_POLL_LOOKBACK_MS;
    const result = await pollIncomingNudges(since);
    if (!result.ok) {
      // Same rationale as pollSessionEventUpdates's identical branch: leave the persisted cursor
      // untouched on a failed fetch so the next tick retries this exact window instead of
      // silently losing whatever nudges arrived during the outage.
      return;
    }
    const settings = await settingsRepo.getSettings();
    const suppressToast =
      !settings.liveNudgesNotificationsEnabled || isWithinQuietHours(settings.quietHours);
    for (const nudge of result.nudges) {
      if (suppressToast) continue;
      const messageText = nudgeMessageText(nudge.messageId) ?? "sent you a nudge";
      showNotification(
        `friend-nudge-${nudge.id}`,
        "Nudge from a friend",
        `${messageText} — from ${nudge.senderUserId}`
      );
    }
    await setLastNudgePollAt(now);
  } catch (err) {
    console.error("Failed to poll friend nudges", err);
  }
}

// v3.4 Task 3: applies an approved site_unlock friend request to the affected LOCAL session -
// renamed from applyApprovedUnlockRequest, same body verbatim (only the request's type changed,
// from UnlockRequest to FriendRequest). This can only run on the *requester's* device (the
// resolving friend's device has no access to, and no business mutating, the requester's
// chrome.storage.local session state) - which is exactly why this is only ever called from
// pollFriendRequestUpdates below, gated on `req.requesterUserId === userId` (the current device's
// own signed-in user).
//
// allowedSites IS what classifySite() checks first (src/domain/sites/siteRules.ts) and returns
// ALLOWED immediately on a match - the same mechanism MARK_SITE_STUDY_RELATED already uses in
// messageRouter.ts.
//
// Guards against a stale/mismatched approval: the request's session_id must match the CURRENTLY
// active session's id (the user could have ended that session and started a new one, or ended
// it entirely, before a friend got around to approving), and the session must not already be in
// a terminal state (COMPLETED/ABANDONED) - mutating allowedSites on a session that's already
// over would be a silent no-op at best and confusing at worst. Idempotent: if the hostname is
// already in allowedSites (e.g. a re-poll after a service-worker restart re-delivers the same
// approval, or the user separately used MARK_SITE_STUDY_RELATED for it), this is a no-op rather
// than writing a duplicate entry.
async function applyApprovedFriendRequest(req: FriendRequest): Promise<void> {
  const session = await settingsRepo.getActiveSession();
  if (!session || !req.hostname || session.id !== req.sessionId) return;
  if (session.state === "COMPLETED" || session.state === "ABANDONED") return;
  if (session.allowedSites.includes(req.hostname)) return;

  const updated = { ...session, allowedSites: [...session.allowedSites, req.hostname] };
  await settingsRepo.saveActiveSession(updated);
}

// v3.4 Task 3: applies an approved site_temp_pass friend request - renamed from
// applyApprovedTempPasscodeRequest, same body verbatim. "Silently extend what the user is already
// allowed to do", safe to run unattended from this background poll (Global Constraints: a
// background poll never triggers a disruptive UI action on its own; unlocking a single
// already-approved hostname is exactly the kind of non-disruptive extension that's fine here,
// unlike ending a session). Works through the DNR rule/relock-alarm mechanism
// (unlockHardBlockRuleForHostname + scheduleTempUnlockRelockAlarm), same as
// friendRequestApi.ts's claimApproval does when the user is looking at LockedPage.tsx directly -
// this means the unlock can happen from the background poll alone, without the user ever
// reopening LockedPage.tsx after their friend approves.
async function applyApprovedTempPass(req: FriendRequest): Promise<void> {
  if (!req.hostname) return;
  try {
    await unlockHardBlockRuleForHostname(req.hostname);
    if (req.expiresAt) {
      scheduleTempUnlockRelockAlarm(req.hostname, req.expiresAt);
    }
  } catch (err) {
    console.error("Failed to apply an approved temp passcode request", err);
  }
}

// v3.4 Task 3: replaces pollUnlockRequestUpdates/pollTempPasscodeUpdates/
// pollSessionEndRequestUpdates - one stream backing all three kinds now that they're one
// friend_requests table behind one pollRelevantRequests query (see friendRequestApi.ts's
// queryRelevantSince comment on why one query covers both directions below). Reuses Task 6's
// alarm/notification path, not a new one, same as every other stream on this file.
//
//   (a) the requester's OWN request just got resolved (approved/denied) - apply the local side
//       effect on approval (site_unlock's allowedSites mutation; site_temp_pass's DNR-unlock +
//       relock-alarm; session_end has deliberately NO auto-apply - see below), then notify
//       either way, with copy distinct per kind;
//   (b) a NEW pending request from someone else the current user is friends with (or assigned to
//       specifically) - notify so the friend knows to open the panel and review it.
//
// A row that's the current user's own STILL-pending request (they just created it themselves) is
// intentionally skipped - they already know, no notification needed. Same "only advance the
// cursor on confirmed success" discipline as every other stream, using its own independent
// cursor (getLastFriendRequestPollAt/setLastFriendRequestPollAt).
//
// session_end's branch deliberately does NOT call any apply-side-effect function at all, on
// purpose - preserved verbatim from pollSessionEndRequestUpdates's own asymmetry. Per the Global
// Constraints note: unlocking a hostname (site_unlock) or a site (site_temp_pass) is "silently
// extend what the user is already allowed to do" - safe to run unattended. Ending a session is
// disruptive - it stops what the user is doing - so an approved session-end request is NEVER
// auto-applied from this background poll. This function only ever produces a notification for
// that kind; the actual SESSION_END call still requires the user to return to
// EndSessionControl.tsx and click "End session now" themselves. Do not "fix" this into
// auto-ending a session without re-deciding that on purpose, in writing, the way this codebase's
// plan history already did once (docs/implementation_plans/V3.3_Implementation_Plan.md).
async function pollFriendRequestUpdates(userId: string): Promise<void> {
  try {
    const now = Date.now();
    const since = (await getLastFriendRequestPollAt()) ?? now - FIRST_POLL_LOOKBACK_MS;
    const result = await pollRelevantRequests(since);
    if (!result.ok) {
      // Same rationale as every other poll function's identical branch: leave the persisted
      // cursor untouched on a failed fetch so the next tick retries this exact window instead of
      // silently losing whatever pending requests/resolutions arrived during the outage.
      return;
    }
    for (const req of result.requests) {
      if (req.requesterUserId === userId) {
        if (req.status === "approved") {
          if (req.kind === "site_unlock") {
            await applyApprovedFriendRequest(req);
            showNotification(
              `friend-request-${req.id}`,
              "Unlock request approved",
              `${req.hostname} is now allowed for the rest of this session.`
            );
          } else if (req.kind === "site_temp_pass") {
            await applyApprovedTempPass(req);
            showNotification(
              `friend-request-${req.id}`,
              "Temporary passcode approved",
              `${req.hostname} is now unlocked for a limited time.`
            );
          } else {
            // session_end: notification only, deliberately no auto-apply - see this function's
            // own header comment and the Global Constraints note.
            showNotification(
              `friend-request-${req.id}`,
              "Temporary pass approved",
              "A friend approved your request to end this session early — return to the app to end it."
            );
          }
        } else if (req.status === "denied") {
          const label =
            req.kind === "session_end"
              ? "end this session early"
              : req.kind === "site_temp_pass"
                ? `a temporary passcode for ${req.hostname}`
                : `unlock ${req.hostname}`;
          showNotification(
            `friend-request-${req.id}`,
            "Request denied",
            `Your request to ${label} was denied.`
          );
        }
        // status === "pending" here means it's the requester's own still-unanswered request -
        // nothing to do, they already know they just created it.
      } else if (req.status === "pending") {
        const label =
          req.kind === "session_end"
            ? "end their session early"
            : req.kind === "site_temp_pass"
              ? `a temporary passcode for ${req.hostname}`
              : `unlock ${req.hostname}`;
        showNotification(
          `friend-request-pending-${req.id}`,
          "Friend request",
          `A friend wants to ${label} — open the panel to review.`
        );
      }
    }
    await setLastFriendRequestPollAt(now);
  } catch (err) {
    console.error("Failed to poll friend requests", err);
  }
}

// v2 Task 9, Part D: fourth stream on this same alarm - daily digests. Reuses Task 6's
// alarm/notification path per this task's brief ("Tasks 7, 8, 9, and 14 all share the one
// alarm"), not a new one. Same "only advance the cursor on confirmed success" discipline as the
// other three streams, using its own independent cursor (getLastDigestPollAt/setLastDigestPollAt)
// so a failure here never affects, and is never affected by, the other three cursors.
//
// Cursor is compared against daily_digests.computed_at (not digest_date) - mirrors how the other
// streams use occurred_at/sent_at as their timestamp cursor (see friendPollState.ts and
// digestApi.ts's pollNewDigests). Since compute_daily_digests() (supabase/migrations/
// 20260815000010_v2_daily_digests.sql) upserts exactly one row per (subject_user_id,
// digest_date) - never one row per session - this cursor mechanism alone is what satisfies this
// task's DoD ("a friend ... sees one summary per day, not per session"): a friend's digest row
// for a given day only ever crosses the cursor once (the first poll tick after it's computed),
// regardless of how many sessions fed into it.
//
// The caller's own digest row (digest.friendUserId === userId, i.e. a digest about the current
// user's own activity, which RLS also legitimately returns) is intentionally skipped here - a
// user doesn't need a chrome.notifications toast about their own stats; this stream exists to
// tell a friend about someone ELSE's digest.
// v2 Task 10, Part C: same "gate only the toast, never the fetch/cursor" discipline as
// pollNudgeUpdates above, using `digestNotificationsEnabled`/quietHours instead of
// `liveNudgesNotificationsEnabled`. Deliberately does NOT gate pollSessionEventUpdates or
// pollFriendRequestUpdates - the brief's Part C is explicit that only "live nudges" and "digest"
// get a global toggle (plus quiet hours layered on both); friend-activity and friend-request
// toasts are unaffected by this task, a deliberate scope boundary, not an oversight.
async function pollDigestUpdates(userId: string): Promise<void> {
  try {
    const now = Date.now();
    const since = (await getLastDigestPollAt()) ?? now - FIRST_POLL_LOOKBACK_MS;
    const result = await pollNewDigests(since);
    if (!result.ok) {
      // Same rationale as the other three poll functions' identical branch: leave the persisted
      // cursor untouched on a failed fetch so the next tick retries this exact window instead of
      // silently losing whatever digest(s) were computed during the outage.
      return;
    }
    const settings = await settingsRepo.getSettings();
    const suppressToast =
      !settings.digestNotificationsEnabled || isWithinQuietHours(settings.quietHours);
    for (const digest of result.digests) {
      if (digest.friendUserId === userId) continue;
      if (suppressToast) continue;
      // Copy deliberately distinct from the other three streams' notification titles/bodies
      // ("Friend activity" / "Nudge from a friend" / "Unlock request"...), and echoes the
      // architecture overview's own example phrasing ("Bob was really locked in today") - no
      // display-name lookup exists anywhere in this codebase yet (FriendGroupPanel.tsx has the
      // identical limitation - no `profiles` table), so "A friend" stands in for a real name.
      showNotification(
        `friend-digest-${digest.friendUserId}-${digest.digestDate}`,
        "Daily digest",
        `A friend was really locked in today — ${digest.completedSessions} session${digest.completedSessions === 1 ? "" : "s"} completed, ${digest.distractionCount} distraction${digest.distractionCount === 1 ? "" : "s"}.`
      );
    }
    await setLastDigestPollAt(now);
  } catch (err) {
    console.error("Failed to poll friend digests", err);
  }
}

// v2 Task 14: third stream on this same alarm - producer tags sent to the current user by a
// friend (room deliveries are excluded entirely - see producerTagApi.ts's queryIncomingSince -
// and are instead delivered live via Supabase Realtime broadcast, Part D of this task, which has
// no cursor/alarm involvement at all). Reuses Task 6's alarm/notification path per this task's
// brief ("Do NOT add a new alarm"), not a new one. Same "only advance the cursor on confirmed
// success" discipline as the streams above, using its own independent cursor
// (getLastProducerTagPollAt/setLastProducerTagPollAt) so a failure here never affects, and is
// never affected by, the other cursors. (v3.4 Task 3: renumbered from "sixth" - see
// pollFriendRequestUpdates' own comment for why.)
//
// Notification id is synthesized from tagId+sentAt (`producer_tag_sends` has no id/primary key
// column at all - see the schema migration's own comment on why) rather than a real row
// identity - unique enough for chrome.notifications' dedupe purposes across this stream's own
// polls, which is all this id is used for.
async function pollProducerTagUpdates(): Promise<void> {
  try {
    const now = Date.now();
    const since = (await getLastProducerTagPollAt()) ?? now - FIRST_POLL_LOOKBACK_MS;
    const result = await pollIncomingProducerTagSends(since);
    if (!result.ok) {
      // Same rationale as the other five poll functions' identical branch: leave the persisted
      // cursor untouched on a failed fetch so the next tick retries this exact window instead of
      // silently losing whatever tag(s) a friend sent during the outage.
      return;
    }
    for (const send of result.sends) {
      showNotification(
        `producer-tag-${send.tagId}-${send.sentAt}`,
        "Producer tag from a friend",
        `A friend sent you a short recording — from ${send.senderUserId}.`
      );
    }
    await setLastProducerTagPollAt(now);
  } catch (err) {
    console.error("Failed to poll incoming producer tags", err);
  }
}

// v3.4 Task 2: fourth stream on this same alarm - new friend connections. Reuses Task 6's
// alarm/notification path, not a new one, same as every other stream above. Same "only advance
// the cursor on confirmed success" discipline as the streams above, using its own independent
// cursor (getLastFriendConnectionPollAt/setLastFriendConnectionPollAt) so a failure here never
// affects, and is never affected by, the other cursors. (v3.4 Task 3: renumbered from "eighth" -
// see pollFriendRequestUpdates' own comment for why.)
//
// Finds friendships rows THIS user's invite code generated (initiated_by = userId) created since
// the last poll, and shows one toast per new connection. Uses the same human-name-with-raw-id-
// fallback resolution every other friend-facing notification in this codebase uses -
// profileApi.fetchProfilesByIds([friendId]) then falls back to the raw id, mirroring
// useDisplayNames.ts's own fallback - this is the one poll stream that needs a display name
// inline in its own notification body, rather than leaving name resolution to a UI component,
// since "a friend just connected" reads far better with a real name than a raw uuid, and unlike
// the other streams, this is the FIRST time this specific friend's name is ever surfaced to this
// user.
async function pollFriendConnectionUpdates(userId: string): Promise<void> {
  try {
    const now = Date.now();
    const since = (await getLastFriendConnectionPollAt()) ?? now - FIRST_POLL_LOOKBACK_MS;
    const { data, error } = await supabase
      .from("friendships")
      .select("user_id_a, user_id_b, initiated_by, created_at")
      .eq("initiated_by", userId)
      .gt("created_at", new Date(since).toISOString());
    if (error) {
      // Same rationale as the other seven poll functions' identical branch: leave the persisted
      // cursor untouched on a failed fetch so the next tick retries this exact window instead of
      // silently losing whatever connection(s) were made during the outage.
      return;
    }
    for (const row of data ?? []) {
      const friendId = row.user_id_a === userId ? row.user_id_b : row.user_id_a;
      const profiles = await profileApi.fetchProfilesByIds([friendId]);
      const name = profiles[0]?.humanName ?? friendId;
      showNotification(
        `friend-connection-${friendId}-${row.created_at}`,
        "New friend connection",
        `${name} just connected using your invite`
      );
    }
    await setLastFriendConnectionPollAt(now);
  } catch (err) {
    console.error("Failed to poll new friend connections", err);
  }
}

// Runs all six poll streams (session-status events, nudges, daily digests, producer tags, friend
// connections, friend requests) on every friend-poll alarm tick. Best-effort throughout: none of
// pollSessionEventUpdates/pollNudgeUpdates/pollDigestUpdates/pollProducerTagUpdates/
// pollFriendConnectionUpdates/pollFriendRequestUpdates ever throws (each wraps its own body), but
// this outer try/catch stays as a last-resort safety net so nothing here can take down the alarm
// listener. (v3.4 Task 3: was eight streams - unlock_requests/temp_passcode_requests/
// session_end_requests' three separate poll functions collapsed into one pollFriendRequestUpdates
// now that they're one friend_requests table, net -2 overall.)
async function handleFriendPollAlarm(): Promise<void> {
  try {
    // Re-check eligibility on every tick (fix round 1), not just once at alarm-start time
    // (messageRouter.ts's maybeStartFriendPoll runs this same pair of checks, but only when the
    // alarm is first scheduled). friendSyncEnabled can be toggled off, or the user can remove
    // their last friend, mid-session without anything telling this already-running alarm to stop
    // - without re-checking here, it would keep polling Supabase every minute regardless,
    // contradicting the architecture doc's "keep backend load and battery use proportional to
    // actual usage" directive. Skips every fetch entirely (no network call against any table)
    // when either check fails now; does not reactively cancel the alarm itself here (that's a
    // nice-to-have, not required - the alarm's own stop points are still messageRouter.ts's
    // SESSION_END/SESSION_DISMISS_* and this file's natural-completion path).
    const userId = await currentFriendSyncUserId();
    if (!userId) return;
    if (!(await hasAnyFriend(userId))) return;

    await pollSessionEventUpdates();
    await pollNudgeUpdates();
    await pollFriendRequestUpdates(userId);
    await pollDigestUpdates(userId);
    await pollProducerTagUpdates();
    await pollFriendConnectionUpdates(userId);
  } catch (err) {
    console.error("Failed to poll friend events", err);
  }
}

// v2 Task 12: re-locks a single hostname after a temp-passcode-unlocked window expires - see
// declarativeNetRequestApi.ts's lockHardBlockRuleForHostname (the inverse of
// unlockHardBlockRuleForHostname, v2 Task 8) and alarmsApi.ts's scheduleTempUnlockRelockAlarm
// (the alarm that fires this).
//
// Guarded against re-locking a session that's no longer around, or no longer hard-restricted for
// this hostname, by the time this fires - confirmed by checking the active session directly
// rather than assumed, per this task's brief ("if there's no active session or it's not in a
// hard-restricted state anymore, the DNR rules were already cleared by clearHardBlockRules()
// elsewhere, so this is a no-op, but confirm rather than assume"):
//   - no active session at all -> clearHardBlockRules() already ran (SESSION_END/natural
//     completion) - nothing to re-lock.
//   - session in a terminal state (COMPLETED/ABANDONED) -> same as above.
//   - session.restrictionMode is no longer "hard" -> can't happen via any existing mutation path
//     today (restrictionMode is fixed at session creation), but checked anyway as a genuine
//     guard, not a defensive-programming no-op - if a future task ever adds a way to downgrade a
//     session out of hard mode mid-session, this guard is what keeps this alarm from
//     re-introducing a stale hard-block rule for it.
//   - hostname isn't part of the CURRENT session's restrictedSites -> the user could have ended
//     the original hard-mode session and started an entirely different one (possibly hard-mode
//     again, but with a different restricted-site list) before this alarm fired; re-locking a
//     hostname that session doesn't even care about would be adding a stray, orphaned rule.
async function handleTempUnlockRelockAlarm(hostname: string): Promise<void> {
  try {
    const session = await settingsRepo.getActiveSession();
    if (!session) return;
    const nonTerminal =
      session.state === "FOCUSING" || session.state === "PAUSED" || session.state === "BREAK";
    if (!nonTerminal) return;
    if (session.restrictionMode !== "hard") return;
    if (!session.restrictedSites.includes(hostname)) return;

    await lockHardBlockRuleForHostname(hostname);
  } catch (err) {
    console.error("Failed to re-lock hard-block rule after temp-passcode expiry", err);
  }
}

// Task Vault breakdown-item completion (Task 4, fix round 1): a linked TaskBreakdownItem is
// only marked done when its session completes *naturally* (this file, timer-driven), not
// when it's ended early/manually (messageRouter.ts's SESSION_END, which always represents an
// abandonment - see that handler's own comment). TaskRepository has no "find task by
// breakdown item id" lookup (its interface is fixed to
// create/update/delete/list/addBreakdownItem per Task 4's brief), so this scans list() for
// the owning task rather than adding a new repository method.
async function markBreakdownItemCompleted(taskBreakdownItemId: string, now: number): Promise<void> {
  // listAll(), not list(userId) - this is a timer-driven background reconciliation with no
  // "current signed-in user" to scope by (see taskRepository.ts's own comment on listAll()):
  // whoever was signed in (or not) when the task/session was created might not be who's signed
  // in, or signed in at all, by the time that session naturally completes.
  const tasks = await taskRepo.listAll();
  const task = tasks.find((t) => t.breakdown.some((item) => item.id === taskBreakdownItemId));
  if (!task) return;
  await taskRepo.update({
    ...task,
    breakdown: task.breakdown.map((item) =>
      item.id === taskBreakdownItemId ? { ...item, completedAt: now } : item
    ),
  });
}

export async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  // The friend-poll alarm (v2 Task 6) is a completely separate lifecycle from the session-timer
  // alarm below - handled and returned from here first so it never falls through the
  // `!isSessionAlarm` guard that every other/unrecognized alarm name hits.
  if (isFriendPollAlarm(alarm)) {
    await handleFriendPollAlarm();
    return;
  }

  // v2 Task 12: same "completely separate lifecycle, handled and returned from here first"
  // treatment as the friend-poll alarm above - a temp-unlock-relock alarm must never fall through
  // to the session-alarm logic below, and (unlike the friend-poll alarm) must work regardless of
  // friend-sync/group-membership state, so it's checked independently of that branch too.
  if (isTempUnlockRelockAlarm(alarm)) {
    await handleTempUnlockRelockAlarm(hostnameFromTempUnlockRelockAlarm(alarm));
    return;
  }

  if (!isSessionAlarm(alarm)) return;

  const session = await settingsRepo.getActiveSession();
  if (!session) return;

  const now = Date.now();

  if (session.state === "FOCUSING") {
    const completed = machine.completeSession(session, now);
    // Archive immediately (history is accurate the instant it happens), but keep the
    // COMPLETED session as the active session rather than clearing it - previously this
    // nulled the active session in the same breath, so the UI never got a chance to render
    // a completion/"victory" screen. It's cleared once the user acknowledges it via
    // SESSION_DISMISS_COMPLETED (messageRouter.ts).
    await historyRepo.archive(completed);
    await settingsRepo.saveActiveSession(completed);
    await clearHardBlockRules();
    // Natural completion is a session-ending transition - stop polling for friend events (same
    // "only run the alarm while there is an active session" rule messageRouter.ts's SESSION_END
    // abandonment path follows). Recording SESSION_COMPLETED itself is fire-and-forget/gated
    // (see friendSync.ts) - never blocks the archival/notification above, which have already
    // succeeded by this point.
    cancelFriendPollAlarm();
    recordFriendStatusEvent("SESSION_COMPLETED", completed.id, "completed a focus session");
    if (completed.taskBreakdownItemId) {
      try {
        // Best-effort: a Task Vault storage failure here must not prevent the session's own
        // archival/active-session update/notification above, which have already succeeded by
        // this point - the natural-completion flow itself is the part the user is relying on.
        await markBreakdownItemCompleted(completed.taskBreakdownItemId, now);
      } catch (err) {
        console.error("Failed to mark linked task breakdown item complete", err);
      }
    }
    showNotification("session-complete", "Goal complete", `"${session.goal}" is done. Nice work.`);
    return;
  }

  if (session.state === "BREAK") {
    const focusing = machine.endBreak(session, now);
    await settingsRepo.saveActiveSession(focusing);
    showNotification("break-over", "Break's over", "Back to it.");
  }
}

export function registerAlarmHandlers(): void {
  chrome.alarms.onAlarm.addListener(handleAlarm);
}
