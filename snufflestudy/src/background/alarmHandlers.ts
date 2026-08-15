import { isSessionAlarm, isFriendPollAlarm, cancelFriendPollAlarm } from "../infrastructure/browser/alarmsApi";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { IndexedDbTaskRepository } from "../infrastructure/storage/taskRepository";
import * as machine from "../domain/session/sessionMachine";
import { showNotification } from "../infrastructure/browser/notificationsApi";
import { clearHardBlockRules } from "../infrastructure/browser/declarativeNetRequestApi";
import { pollNewEventsForFriends } from "../infrastructure/backend/sessionStatusSyncApi";
import { getLastFriendPollAt, setLastFriendPollAt } from "../infrastructure/storage/friendPollState";
import { currentFriendSyncUserId, isInAnyGroup, recordFriendStatusEvent } from "./friendSync";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();
const taskRepo = new IndexedDbTaskRepository();

// A naturally-completing session never routes back through recordFriendStatusEvent's usual
// caller (messageRouter.ts) - this file's handleAlarm is the only place SESSION_COMPLETED can
// be recorded from (v1 Task 4's markBreakdownItemCompleted needed the exact same relocation for
// the exact same reason - see this file's own comment on that function). Look-back window for
// the very first poll after friend-sync is enabled/a session starts, before any
// getLastFriendPollAt() value has ever been persisted - 5 minutes is comfortably wider than one
// alarm interval (1 minute) so a friend's event from just before this device started polling
// still surfaces once, without dredging up an unbounded historical backlog.
const FIRST_POLL_LOOKBACK_MS = 5 * 60 * 1000;

// Fetches new friend events since the last poll and shows a chrome.notifications toast for each
// (per docs/Draft1_Architecture_Overview.md's Phase 1 "polling" friend-event delivery plan).
// Best-effort throughout: pollNewEventsForFriends already never throws (see
// sessionStatusSyncApi.ts), but this is wrapped anyway so a chrome.storage failure while
// reading/writing the last-checked timestamp can't take down the alarm listener.
async function handleFriendPollAlarm(): Promise<void> {
  try {
    // Re-check eligibility on every tick (fix round 1), not just once at alarm-start time
    // (messageRouter.ts's maybeStartFriendPoll runs this same pair of checks, but only when the
    // alarm is first scheduled). friendSyncEnabled can be toggled off, or the user can leave
    // their last group, mid-session without anything telling this already-running alarm to stop
    // - without re-checking here, it would keep polling Supabase every minute regardless,
    // contradicting the architecture doc's "keep backend load and battery use proportional to
    // actual usage" directive. Skips the events fetch entirely (no network call against
    // session_status_events) when either check fails now; does not reactively cancel the alarm
    // itself here (that's a nice-to-have, not required - the alarm's own stop points are still
    // messageRouter.ts's SESSION_END/SESSION_DISMISS_* and this file's natural-completion path).
    const userId = await currentFriendSyncUserId();
    if (!userId) return;
    if (!(await isInAnyGroup(userId))) return;

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
