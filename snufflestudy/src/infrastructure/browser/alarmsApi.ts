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

// v2 Task 12: schedules the DNR re-lock for a single hostname's temp-passcode unlock, at the
// exact expiresAt the redeem-temp-passcode Edge Function returned. Deliberately its OWN alarm,
// not a reuse of FRIEND_POLL_ALARM above - a temp-passcode redemption must re-lock regardless of
// friend-sync enablement/group-membership/session-active-ness (FRIEND_POLL_ALARM's own
// eligibility gating in alarmHandlers.ts's handleFriendPollAlarm checks exactly those unrelated
// conditions, none of which should be able to suppress a re-lock the user is depending on).
//
// Named per-hostname (not a single shared name) via a fixed prefix - one unlock per hostname at a
// time is the realistic case (a second temp-passcode approval for the SAME hostname while one is
// already unlocked just reschedules this same-named alarm to the new expiry;
// chrome.alarms.create with an existing name replaces it, which is the correct behavior here: the
// newer approval's expiry should win). isTempUnlockRelockAlarm/hostnameFromTempUnlockRelockAlarm
// let alarmHandlers.ts's handleAlarm recognize and parse this alarm type by its name prefix, the
// same way isSessionAlarm/isFriendPollAlarm let it recognize theirs by exact name.
const TEMP_UNLOCK_RELOCK_ALARM_PREFIX = "snufflestudy-temp-unlock-relock-";

function tempUnlockRelockAlarmName(hostname: string): string {
  return `${TEMP_UNLOCK_RELOCK_ALARM_PREFIX}${hostname}`;
}

export function scheduleTempUnlockRelockAlarm(hostname: string, expiresAtEpochMs: number): void {
  chrome.alarms.create(tempUnlockRelockAlarmName(hostname), { when: expiresAtEpochMs });
}

export function cancelTempUnlockRelockAlarm(hostname: string): void {
  chrome.alarms.clear(tempUnlockRelockAlarmName(hostname));
}

export function isTempUnlockRelockAlarm(alarm: chrome.alarms.Alarm): boolean {
  return alarm.name.startsWith(TEMP_UNLOCK_RELOCK_ALARM_PREFIX);
}

// Only meaningful when isTempUnlockRelockAlarm(alarm) is true - callers (alarmHandlers.ts) always
// check that first.
export function hostnameFromTempUnlockRelockAlarm(alarm: chrome.alarms.Alarm): string {
  return alarm.name.slice(TEMP_UNLOCK_RELOCK_ALARM_PREFIX.length);
}
