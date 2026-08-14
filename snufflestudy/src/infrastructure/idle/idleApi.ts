import type { ActivityState } from "../../domain/session/sessionTypes";

// chrome.idle.onStateChanged's real callback parameter is typed `${chrome.idle.IdleState}` (a
// template-literal type over the enum's string values), not the bare enum type - using
// ActivityState here (a plain, structurally-identical string union) matches what Chrome
// actually passes at runtime and this project's domain-purity rule (src/domain/ never imports
// chrome.*). Same rationale as background/idleHandlers.ts's existing direct chrome.idle usage.
type IdleStateValue = `${chrome.idle.IdleState}`;

let activeListener: ((state: IdleStateValue) => void) | undefined;

// Thin wrapper around chrome.idle.setDetectionInterval / chrome.idle.onStateChanged, matching
// the style of infrastructure/browser/alarmsApi.ts. Callers own when monitoring starts/stops;
// this module just tracks the one listener it registered so stopIdleMonitoring can remove
// exactly that one. Calling startIdleMonitoring again without an intervening stop replaces the
// previous listener rather than leaking a second registration.
export function startIdleMonitoring(
  intervalSeconds: number,
  onStateChange: (state: ActivityState) => void
): void {
  stopIdleMonitoring();
  chrome.idle.setDetectionInterval(intervalSeconds);
  activeListener = (state) => onStateChange(state);
  chrome.idle.onStateChanged.addListener(activeListener);
}

export function stopIdleMonitoring(): void {
  if (activeListener) {
    chrome.idle.onStateChanged.removeListener(activeListener);
    activeListener = undefined;
  }
}
