const SESSION_ALARM = "snufflestudy-session-timer";

export function scheduleSessionAlarm(whenEpochMs: number): void {
  chrome.alarms.create(SESSION_ALARM, { when: whenEpochMs });
}

export function cancelSessionAlarm(): void {
  chrome.alarms.clear(SESSION_ALARM);
}

export function isSessionAlarm(alarm: chrome.alarms.Alarm): boolean {
  return alarm.name === SESSION_ALARM;
}

// v2 Task 6: a distinct chrome.alarms name from SESSION_ALARM above, deliberately - the brief
// calls out as a hard requirement that starting/stopping this alarm must never collide with or
// cancel the session-timer alarm (they're independent lifecycles that happen to overlap in
// time: the session-timer alarm counts down to the *local* session's next state transition,
// this one just polls Supabase for friend events roughly once a minute while any session is
// active - see docs/Draft1_Architecture_Overview.md's "Friend-event delivery" Phase 1).
const FRIEND_POLL_ALARM = "snufflestudy-friend-poll";

// periodInMinutes: 1 matches the architecture overview's "roughly once a minute" cadence.
// chrome.alarms.create requires a `when`/`delayInMinutes` for the first fire even when a period
// is given - delayInMinutes: 1 means the first poll happens one interval in, not immediately,
// which is fine since this only ever starts alongside a session that will run far longer than
// a minute.
export function scheduleFriendPollAlarm(): void {
  chrome.alarms.create(FRIEND_POLL_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}

export function cancelFriendPollAlarm(): void {
  chrome.alarms.clear(FRIEND_POLL_ALARM);
}

export function isFriendPollAlarm(alarm: chrome.alarms.Alarm): boolean {
  return alarm.name === FRIEND_POLL_ALARM;
}
