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

// v2 Task 7: a second, independent cursor for the nudge stream polled by the same alarm tick
// (handleFriendPollAlarm in alarmHandlers.ts). Session-status events and nudges are two logically
// separate streams delivered by the same chrome.alarms entry ("snufflestudy-friend-poll" - Task 7
// reuses Task 6's alarm rather than adding a second one), so each needs its own "last checked"
// bookmark - advancing one must never advance the other, since a failure fetching one stream on a
// given tick shouldn't affect whether the other stream's cursor moves. Same get/set shape and the
// same "only advance on confirmed success" discipline as getLastFriendPollAt/setLastFriendPollAt
// above - see that pair's comment and alarmHandlers.ts's handleFriendPollAlarm.
const LAST_NUDGE_POLL_KEY = "snufflestudy.friendPollLastNudgeCheckedAt";

export async function getLastNudgePollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_NUDGE_POLL_KEY, number>>(
    LAST_NUDGE_POLL_KEY
  );
  return result[LAST_NUDGE_POLL_KEY] ?? null;
}

export async function setLastNudgePollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_NUDGE_POLL_KEY]: timestamp });
}
