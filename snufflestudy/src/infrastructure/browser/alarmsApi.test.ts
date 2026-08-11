import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { scheduleSessionAlarm, cancelSessionAlarm, isSessionAlarm } from "./alarmsApi";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("alarmsApi", () => {
  it("schedules an alarm at the given timestamp", async () => {
    scheduleSessionAlarm(50_000);
    const alarm = await chrome.alarms.get("snufflestudy-session-timer");
    expect(alarm?.scheduledTime).toBe(50_000);
  });

  it("cancels the session alarm", async () => {
    scheduleSessionAlarm(50_000);
    cancelSessionAlarm();
    const alarm = await chrome.alarms.get("snufflestudy-session-timer");
    expect(alarm).toBeUndefined();
  });

  it("identifies the session alarm by name", () => {
    expect(isSessionAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm)).toBe(true);
    expect(isSessionAlarm({ name: "something-else" } as chrome.alarms.Alarm)).toBe(false);
  });
});
