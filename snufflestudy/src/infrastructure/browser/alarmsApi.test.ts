import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  scheduleSessionAlarm,
  cancelSessionAlarm,
  isSessionAlarm,
  scheduleFriendPollAlarm,
  cancelFriendPollAlarm,
  isFriendPollAlarm,
} from "./alarmsApi";

beforeEach(() => {
  fakeBrowser.reset();
});

// v2 Task 6: the friend-poll alarm must use a name distinct from the session-timer alarm, and
// starting/stopping one must never collide with or cancel the other - a hard requirement called
// out explicitly in the Task 6 brief.
describe("friend-poll alarm is independent of the session-timer alarm", () => {
  it("scheduleFriendPollAlarm creates an alarm named snufflestudy-friend-poll with a 1-minute period, without touching the session-timer alarm", async () => {
    scheduleFriendPollAlarm();

    const friendPollAlarm = await chrome.alarms.get("snufflestudy-friend-poll");
    expect(friendPollAlarm).toBeDefined();
    expect(friendPollAlarm!.periodInMinutes).toBe(1);
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeUndefined();
  });

  it("cancelFriendPollAlarm clears only the friend-poll alarm, leaving an active session-timer alarm untouched", async () => {
    scheduleSessionAlarm(Date.now() + 60_000);
    scheduleFriendPollAlarm();

    cancelFriendPollAlarm();

    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeDefined();
  });

  it("cancelSessionAlarm clears only the session-timer alarm, leaving an active friend-poll alarm untouched", async () => {
    scheduleSessionAlarm(Date.now() + 60_000);
    scheduleFriendPollAlarm();

    cancelSessionAlarm();

    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeUndefined();
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeDefined();
  });

  it("isSessionAlarm/isFriendPollAlarm correctly discriminate between the two alarm names (and reject a third)", () => {
    expect(isSessionAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm)).toBe(true);
    expect(isSessionAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm)).toBe(false);
    expect(isFriendPollAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm)).toBe(true);
    expect(isFriendPollAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm)).toBe(false);
    expect(isSessionAlarm({ name: "some-other-alarm" } as chrome.alarms.Alarm)).toBe(false);
    expect(isFriendPollAlarm({ name: "some-other-alarm" } as chrome.alarms.Alarm)).toBe(false);
  });
});
