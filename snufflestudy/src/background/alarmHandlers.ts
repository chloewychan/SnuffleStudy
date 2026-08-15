import { isSessionAlarm, isFriendPollAlarm, cancelFriendPollAlarm } from "../infrastructure/browser/alarmsApi";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { IndexedDbTaskRepository } from "../infrastructure/storage/taskRepository";
import * as machine from "../domain/session/sessionMachine";
import { showNotification } from "../infrastructure/browser/notificationsApi";
import { clearHardBlockRules } from "../infrastructure/browser/declarativeNetRequestApi";
import { pollNewEventsForFriends } from "../infrastructure/backend/sessionStatusSyncApi";
import { pollIncomingNudges } from "../infrastructure/backend/nudgeApi";
import {
  pollRelevantUnlockRequests,
  type UnlockRequest,
} from "../infrastructure/backend/unlockRequestApi";
import { pollNewDigests } from "../infrastructure/backend/digestApi";
import { nudgeMessageText } from "../domain/accountability/nudgeMessages";
import {
  getLastFriendPollAt,
  setLastFriendPollAt,
  getLastNudgePollAt,
  setLastNudgePollAt,
  getLastUnlockPollAt,
  setLastUnlockPollAt,
  getLastDigestPollAt,
  setLastDigestPollAt,
} from "../infrastructure/storage/friendPollState";
import { currentFriendSyncUserId, isInAnyGroup, recordFriendStatusEvent } from "./friendSync";

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
    for (const nudge of result.nudges) {
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

// v2 Task 8, Part B of this task's brief: applies an approved unlock request to the affected
// LOCAL session. This can only run on the *requester's* device (the resolving friend's device
// has no access to, and no business mutating, the requester's chrome.storage.local session
// state) - which is exactly why this is only ever called from pollUnlockRequestUpdates below,
// gated on `req.requesterUserId === userId` (the current device's own signed-in user).
//
// The plan's literal wording ("reuse the siteRestrictionOverrides mechanism from v1's
// StudySession") is NOT what this does - see this task's report for the full trace, but in
// short: siteRestrictionOverrides only ever changes a BLOCKED site's severity (soft vs. hard),
// it is never consulted by classifySite() at all, and tabHandlers.ts's warning path already
// returns early for anything classifySite() doesn't call BLOCKED - so a hostname could never
// stop being blocked, or stop warning, via that mechanism. allowedSites IS what classifySite()
// checks first (src/domain/sites/siteRules.ts) and returns ALLOWED immediately on a match - the
// same mechanism MARK_SITE_STUDY_RELATED already uses in messageRouter.ts - so this reuses that
// existing, already-proven path instead.
//
// Guards against a stale/mismatched approval: the request's session_id must match the CURRENTLY
// active session's id (the user could have ended that session and started a new one, or ended
// it entirely, before a friend got around to approving), and the session must not already be in
// a terminal state (COMPLETED/ABANDONED) - mutating allowedSites on a session that's already
// over would be a silent no-op at best and confusing at worst. Idempotent: if the hostname is
// already in allowedSites (e.g. a re-poll after a service-worker restart re-delivers the same
// approval, or the user separately used MARK_SITE_STUDY_RELATED for it), this is a no-op rather
// than writing a duplicate entry.
async function applyApprovedUnlockRequest(req: UnlockRequest): Promise<void> {
  const session = await settingsRepo.getActiveSession();
  if (!session || session.id !== req.sessionId) return;
  if (session.state === "COMPLETED" || session.state === "ABANDONED") return;
  if (session.allowedSites.includes(req.hostname)) return;

  const updated = { ...session, allowedSites: [...session.allowedSites, req.hostname] };
  await settingsRepo.saveActiveSession(updated);
}

// Polls unlock_requests for two distinct things relevant to the current user (v2 Task 8, reusing
// Task 6's alarm/notification path per this task's brief), both delivered by the same
// pollRelevantUnlockRequests query (see unlockRequestApi.ts's comment on why one query covers
// both):
//   (a) the requester's OWN request just got resolved (approved/denied) - apply the
//       allowedSites change on approval, then notify either way, with copy distinct from both
//       pollSessionEventUpdates's and pollNudgeUpdates's;
//   (b) a NEW pending request from someone else sharing a group with the current user - notify
//       so the friend knows to open the panel and review it.
// A row that's the current user's own STILL-pending request (they just created it themselves) is
// intentionally skipped - they already know, no notification needed. Same "only advance the
// cursor on confirmed success" discipline as the two poll functions above, using its own
// independent cursor (getLastUnlockPollAt/setLastUnlockPollAt) so a failure here never affects,
// and is never affected by, the session-events or nudge cursors.
async function pollUnlockRequestUpdates(userId: string): Promise<void> {
  try {
    const now = Date.now();
    const since = (await getLastUnlockPollAt()) ?? now - FIRST_POLL_LOOKBACK_MS;
    const result = await pollRelevantUnlockRequests(since);
    if (!result.ok) {
      // Same rationale as the other two poll functions' identical branch: leave the persisted
      // cursor untouched on a failed fetch so the next tick retries this exact window instead of
      // silently losing whatever pending requests/resolutions arrived during the outage.
      return;
    }
    for (const req of result.requests) {
      if (req.requesterUserId === userId) {
        if (req.status === "approved") {
          await applyApprovedUnlockRequest(req);
          showNotification(
            `unlock-request-${req.id}`,
            "Unlock request approved",
            `${req.hostname} is now allowed for the rest of this session.`
          );
        } else if (req.status === "denied") {
          showNotification(
            `unlock-request-${req.id}`,
            "Unlock request denied",
            `Your request to unlock ${req.hostname} was denied.`
          );
        }
        // status === "pending" here means it's the requester's own still-unanswered request -
        // nothing to do, they already know they just created it.
      } else if (req.status === "pending") {
        showNotification(
          `unlock-request-pending-${req.id}`,
          "Unlock request",
          `A friend wants to unlock ${req.hostname} — open the panel to review.`
        );
      }
    }
    await setLastUnlockPollAt(now);
  } catch (err) {
    console.error("Failed to poll unlock requests", err);
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
    for (const digest of result.digests) {
      if (digest.friendUserId === userId) continue;
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

// Runs all four poll streams (session-status events, nudges, unlock requests, daily digests) on
// every friend-poll alarm tick. Best-effort throughout: none of pollSessionEventUpdates/
// pollNudgeUpdates/pollUnlockRequestUpdates/pollDigestUpdates ever throws (each wraps its own
// body), but this outer try/catch stays as a last-resort safety net so nothing here can take down
// the alarm listener.
async function handleFriendPollAlarm(): Promise<void> {
  try {
    // Re-check eligibility on every tick (fix round 1), not just once at alarm-start time
    // (messageRouter.ts's maybeStartFriendPoll runs this same pair of checks, but only when the
    // alarm is first scheduled). friendSyncEnabled can be toggled off, or the user can leave
    // their last group, mid-session without anything telling this already-running alarm to stop
    // - without re-checking here, it would keep polling Supabase every minute regardless,
    // contradicting the architecture doc's "keep backend load and battery use proportional to
    // actual usage" directive. Skips every fetch entirely (no network call against any table)
    // when either check fails now; does not reactively cancel the alarm itself here (that's a
    // nice-to-have, not required - the alarm's own stop points are still messageRouter.ts's
    // SESSION_END/SESSION_DISMISS_* and this file's natural-completion path).
    const userId = await currentFriendSyncUserId();
    if (!userId) return;
    if (!(await isInAnyGroup(userId))) return;

    await pollSessionEventUpdates();
    await pollNudgeUpdates();
    await pollUnlockRequestUpdates(userId);
    await pollDigestUpdates(userId);
  } catch (err) {
    console.error("Failed to poll friend events", err);
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
  const tasks = await taskRepo.list();
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
