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

// A second, independent cursor for the nudge stream polled by the same alarm tick
// (handleFriendPollAlarm in alarmHandlers.ts). Session-status events and nudges are two logically
// separate streams delivered by the same chrome.alarms entry ("snufflestudy-friend-poll"), so
// each needs its own "last checked" bookmark - advancing one must never advance the other, since
// a failure fetching one stream on a given tick shouldn't affect whether the other stream's
// cursor moves. Same get/set shape and the same "only advance on confirmed success" discipline as
// getLastFriendPollAt/setLastFriendPollAt above - see that pair's comment and alarmHandlers.ts's
// handleFriendPollAlarm.
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

// A third, independent cursor for the consolidated friend-request stream
// (pollFriendRequestUpdates in alarmHandlers.ts) polled by the same alarm tick
// (handleFriendPollAlarm). unlock_requests/temp_passcode_requests/session_end_requests are all
// rows in a single friend_requests table behind one poll query, so this one cursor covers all
// three. Same get/set shape and the same "only advance on confirmed success" discipline every
// cursor in this file already follows.
const LAST_FRIEND_REQUEST_POLL_KEY = "snufflestudy.friendPollLastFriendRequestCheckedAt";

export async function getLastFriendRequestPollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_FRIEND_REQUEST_POLL_KEY, number>>(
    LAST_FRIEND_REQUEST_POLL_KEY
  );
  return result[LAST_FRIEND_REQUEST_POLL_KEY] ?? null;
}

export async function setLastFriendRequestPollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_FRIEND_REQUEST_POLL_KEY]: timestamp });
}

// A fourth, independent cursor for the daily-digest stream polled by the same alarm tick
// (handleFriendPollAlarm in alarmHandlers.ts), reusing that same alarm rather than a new one.
// Same get/set shape and the same "only advance on confirmed success" discipline as the cursors
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

// A fifth, independent cursor for the producer-tag (friend-delivery side only - see
// producerTagApi.ts's queryIncomingSince) stream polled by the same alarm tick
// (handleFriendPollAlarm in alarmHandlers.ts), reusing that same alarm rather than a new one.
// Same get/set shape and the same "only advance on confirmed success" discipline as the cursors
// above, for the identical reason: this is a logically separate stream delivered by the same
// chrome.alarms entry, so it needs its own "last checked" bookmark that advances independently of
// the others' success/failure on any given tick. Room delivery has no cursor at all - it's
// delivered live via Supabase Realtime, not polled.
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

// A sixth, independent cursor for the friend-connection stream
// (pollFriendConnectionUpdates in alarmHandlers.ts), reusing the same alarm as every other stream
// in this file rather than a new one. Same get/set shape and the same "only advance on confirmed
// success" discipline as the cursors above, for the identical reason: this is a logically separate
// stream delivered by the same chrome.alarms entry, so it needs its own "last checked" bookmark
// that advances independently of the others' success/failure on any given tick.
const LAST_FRIEND_CONNECTION_POLL_KEY = "snufflestudy.friendPollLastConnectionCheckedAt";

export async function getLastFriendConnectionPollAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_FRIEND_CONNECTION_POLL_KEY, number>>(
    LAST_FRIEND_CONNECTION_POLL_KEY
  );
  return result[LAST_FRIEND_CONNECTION_POLL_KEY] ?? null;
}

export async function setLastFriendConnectionPollAt(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_FRIEND_CONNECTION_POLL_KEY]: timestamp });
}
