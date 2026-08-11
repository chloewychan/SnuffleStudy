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
