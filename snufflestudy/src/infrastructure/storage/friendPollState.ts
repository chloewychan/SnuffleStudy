// Persists the friend-poll alarm's last-checked timestamp across service-worker restarts (MV3
// service workers are killed/respawned frequently - an in-memory variable would replay every
// friend event since account creation the next time the alarm fires after a restart). Mirrors
// ChromeStorageRepository's style of wrapping chrome.storage.local.get/set behind a single
// namespaced key, but kept as its own small module rather than added to that class: this key
// isn't part of SettingsRepository's fixed interface (settings/activeSession/
// hardBlockCredential), and alarmHandlers.ts is the only caller.
const LAST_POLL_KEY = "snufflestudy.friendPollLastCheckedAt";

export async function getLastFriendPollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_POLL_KEY, number>>(
    LAST_POLL_KEY
  );
  return result[LAST_POLL_KEY] ?? null;
}

export async function setLastFriendPollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_POLL_KEY]: timestamp });
}
