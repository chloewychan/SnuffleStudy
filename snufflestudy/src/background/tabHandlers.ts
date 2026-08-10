import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { classifySite, restrictionModeFor } from "../domain/sites/siteRules";
import * as machine from "../domain/session/sessionMachine";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();

function hostnameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export async function handleTabUpdate(
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab
): Promise<void> {
  if (changeInfo.status !== "complete") return;

  const settings = await settingsRepo.getSettings();
  if (settings.trackingTier !== "detailed") return;

  const session = await settingsRepo.getActiveSession();
  if (!session || session.state !== "FOCUSING") return;

  // chrome.tabs.onUpdated's changeInfo only carries the properties that changed in that
  // particular delta - url is present on the loading-phase update, not on the terminal
  // {status: "complete"} update this handler gates on. The full current tab state (including
  // url) lives in the third listener argument instead.
  const hostname = hostnameFromUrl(tab.url);
  const classification = classifySite(session, hostname);
  if (classification !== "BLOCKED" || hostname === null) return;

  const mode = restrictionModeFor(session, hostname);
  if (mode === "hard") return; // declarativeNetRequest already redirected this navigation

  const updated = machine.recordDistractionAttempt(machine.warnSession(session));
  await settingsRepo.saveActiveSession(updated);
  await historyRepo.recordEvent({
    id: crypto.randomUUID(),
    sessionId: session.id,
    type: "DISTRACTION_ATTEMPT",
    occurredAt: Date.now(),
    hostname,
  });
}

export function registerTabHandlers(): void {
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    void handleTabUpdate(changeInfo, tab);
  });
}
