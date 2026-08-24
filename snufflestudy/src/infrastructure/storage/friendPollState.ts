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

// v2 Task 8: a third, independent cursor for the unlock-request stream polled by the same alarm
// tick (handleFriendPollAlarm in alarmHandlers.ts) - reuses Task 6's alarm per this task's brief
// ("Tasks 7, 8, 9, and 14 all reuse this exact poll/notification path"), not a new alarm. Same
// get/set shape and the same "only advance on confirmed success" discipline as
// getLastFriendPollAt/getLastNudgePollAt above, for the identical reason: session-status events,
// nudges, and unlock requests are three logically separate streams delivered by the same
// chrome.alarms entry, so each needs its own "last checked" bookmark that advances independently
// of the others' success/failure on any given tick.
const LAST_UNLOCK_POLL_KEY = "snufflestudy.friendPollLastUnlockCheckedAt";

export async function getLastUnlockPollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_UNLOCK_POLL_KEY, number>>(
    LAST_UNLOCK_POLL_KEY
  );
  return result[LAST_UNLOCK_POLL_KEY] ?? null;
}

export async function setLastUnlockPollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_UNLOCK_POLL_KEY]: timestamp });
}

// v2 Task 9: a fourth, independent cursor for the daily-digest stream polled by the same alarm
// tick (handleFriendPollAlarm in alarmHandlers.ts) - reuses Task 6's alarm per this task's brief
// ("Tasks 7, 8, 9, and 14 all reuse this exact poll/notification path"), not a new alarm. Same
// get/set shape and the same "only advance on confirmed success" discipline as the three cursors
// above, for the identical reason: session-status events, nudges, unlock requests, and daily
// digests are four logically separate streams delivered by the same chrome.alarms entry, so each
// needs its own "last checked" bookmark that advances independently of the others' success/
// failure on any given tick.
//
// Compared against daily_digests.computed_at (see digestApi.ts's pollNewDigests), not
// digest_date - this is what makes "one summary per day, not per session" fall out of the cursor
// alone: compute_daily_digests() upserts exactly one row per (subject_user_id, digest_date), so a
// given day's row only ever crosses this cursor once (the first poll after it's computed).
const LAST_DIGEST_POLL_KEY = "snufflestudy.friendPollLastDigestCheckedAt";

export async function getLastDigestPollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_DIGEST_POLL_KEY, number>>(
    LAST_DIGEST_POLL_KEY
  );
  return result[LAST_DIGEST_POLL_KEY] ?? null;
}

export async function setLastDigestPollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_DIGEST_POLL_KEY]: timestamp });
}

// v2 Task 12: a fifth, independent cursor for the temp-passcode-request stream polled by the same
// alarm tick (handleFriendPollAlarm in alarmHandlers.ts) - reuses Task 6's alarm per this task's
// brief ("extend Task 6's shared poll... add a fifth: pollTempPasscodeUpdates"), not a new one.
// Same get/set shape and the same "only advance on confirmed success" discipline as the four
// cursors above, for the identical reason: this is a fifth logically separate stream delivered by
// the same chrome.alarms entry, so it needs its own "last checked" bookmark that advances
// independently of the other four's success/failure on any given tick.
const LAST_TEMP_PASSCODE_POLL_KEY = "snufflestudy.friendPollLastTempPasscodeCheckedAt";

export async function getLastTempPasscodePollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_TEMP_PASSCODE_POLL_KEY, number>>(
    LAST_TEMP_PASSCODE_POLL_KEY
  );
  return result[LAST_TEMP_PASSCODE_POLL_KEY] ?? null;
}

export async function setLastTempPasscodePollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_TEMP_PASSCODE_POLL_KEY]: timestamp });
}

// v2 Task 14: a sixth, independent cursor for the producer-tag (friend-delivery side only - see
// producerTagApi.ts's queryIncomingSince) stream polled by the same alarm tick
// (handleFriendPollAlarm in alarmHandlers.ts) - reuses Task 6's alarm per this task's brief ("Do
// NOT add a new alarm"). Same get/set shape and the same "only advance on confirmed success"
// discipline as the five cursors above, for the identical reason: this is a sixth logically
// separate stream delivered by the same chrome.alarms entry, so it needs its own "last checked"
// bookmark that advances independently of the other five's success/failure on any given tick. Room
// delivery has no cursor at all - it's delivered live via Supabase Realtime (Part D), not polled.
const LAST_PRODUCER_TAG_POLL_KEY = "snufflestudy.friendPollLastProducerTagCheckedAt";

export async function getLastProducerTagPollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_PRODUCER_TAG_POLL_KEY, number>>(
    LAST_PRODUCER_TAG_POLL_KEY
  );
  return result[LAST_PRODUCER_TAG_POLL_KEY] ?? null;
}

export async function setLastProducerTagPollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_PRODUCER_TAG_POLL_KEY]: timestamp });
}

// v3.3 Task 12: a seventh, independent cursor for the session-end-request stream polled by the
// same alarm tick (handleFriendPollAlarm in alarmHandlers.ts) - reuses Task 6's alarm, not a new
// one, same as every other stream on this file. Same get/set shape and the same "only advance on
// confirmed success" discipline as the six cursors above, for the identical reason: this is a
// seventh logically separate stream delivered by the same chrome.alarms entry, so it needs its own
// "last checked" bookmark that advances independently of the other six's success/failure on any
// given tick.
const LAST_SESSION_END_POLL_KEY = "snufflestudy.friendPollLastSessionEndCheckedAt";

export async function getLastSessionEndPollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_SESSION_END_POLL_KEY, number>>(
    LAST_SESSION_END_POLL_KEY
  );
  return result[LAST_SESSION_END_POLL_KEY] ?? null;
}

export async function setLastSessionEndPollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_SESSION_END_POLL_KEY]: timestamp });
}
