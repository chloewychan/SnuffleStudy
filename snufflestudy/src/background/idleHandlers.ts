import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import * as machine from "../domain/session/sessionMachine";
import type { ActivityState } from "../domain/session/sessionTypes";

const settingsRepo = new ChromeStorageRepository();

// 15 seconds is the minimum chrome.idle.setDetectionInterval allows - a more responsive
// activity indicator than the 60s default, since this drives a live UI dot rather than a
// background housekeeping task.
const DETECTION_INTERVAL_SECONDS = 15;

// chrome.idle.onStateChanged's real callback parameter is typed `${chrome.idle.IdleState}`
// (a template-literal type over the enum's string values), not the bare enum type - using
// ActivityState here (a plain, structurally-identical string union) matches both what
// Chrome actually passes at runtime and this project's domain-purity rule (src/domain/
// never imports chrome.*).
export async function handleIdleStateChanged(state: ActivityState): Promise<void> {
  const session = await settingsRepo.getActiveSession();
  if (!session || session.state !== "FOCUSING") return;

  const updated = machine.setActivityState(session, state);
  await settingsRepo.saveActiveSession(updated);
}

export function registerIdleHandlers(): void {
  chrome.idle.setDetectionInterval(DETECTION_INTERVAL_SECONDS);
  chrome.idle.onStateChanged.addListener((state) => {
    void handleIdleStateChanged(state);
  });
}
