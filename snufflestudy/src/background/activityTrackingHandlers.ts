import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { startIdleMonitoring } from "../infrastructure/idle/idleApi";
import type { ActivityState } from "../domain/session/sessionTypes";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();

// 15 seconds is the minimum chrome.idle.setDetectionInterval allows. idleHandlers.ts
// separately calls chrome.idle.setDetectionInterval with the same value for its own
// live-activity-dot listener - both calls are idempotent (same value) and chrome.idle
// supports multiple independent onStateChanged listeners, so this module's history-recording
// concern and idleHandlers.ts's UI-state concern don't interfere with each other.
const DETECTION_INTERVAL_SECONDS = 15;

function newId(): string {
  return crypto.randomUUID();
}

// Gives the activity-only tracking tier actual behavior (v2 Decision 3): idle transitions are
// recorded as logged SessionEvents, never used to auto-pause - auto-pausing would remove user
// agency and repeat the "claims to know if you're really studying" mistake the product already
// avoids. Only records while trackingTier is "activity-only", the activityTrackingEnabled
// toggle is on, and a session is actively FOCUSING (not PAUSED/BREAK/etc.) - each condition is
// re-checked on every event rather than via an explicit start/stop subscription, so flipping
// the toggle off (or a session leaving FOCUSING) takes effect on the very next idle transition
// without needing to hook every session-lifecycle call site.
export async function handleActivityTrackingStateChanged(state: ActivityState): Promise<void> {
  try {
    const settings = await settingsRepo.getSettings();
    if (settings.trackingTier !== "activity-only" || !settings.activityTrackingEnabled) return;

    const session = await settingsRepo.getActiveSession();
    if (!session || session.state !== "FOCUSING") return;

    await historyRepo.recordEvent({
      id: newId(),
      sessionId: session.id,
      type: state === "active" ? "USER_RETURNED_FROM_IDLE" : "USER_WENT_IDLE",
      occurredAt: Date.now(),
    });
  } catch (err) {
    // chrome.idle.onStateChanged listeners have nowhere to propagate a rejection to - log
    // instead of letting a storage failure become an unhandled promise rejection in the
    // background service worker.
    console.error("Failed to record activity-tracking event", err);
  }
}

export function registerActivityTrackingHandlers(): void {
  startIdleMonitoring(DETECTION_INTERVAL_SECONDS, (state) => {
    void handleActivityTrackingStateChanged(state);
  });
}
