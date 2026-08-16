import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  scheduleSessionAlarm,
  cancelSessionAlarm,
  isSessionAlarm,
  scheduleFriendPollAlarm,
  cancelFriendPollAlarm,
  isFriendPollAlarm,
  scheduleTempUnlockRelockAlarm,
  cancelTempUnlockRelockAlarm,
  isTempUnlockRelockAlarm,
  hostnameFromTempUnlockRelockAlarm,
} from "./alarmsApi";

beforeEach(() => {
  fakeBrowser.reset();
});

// Pre-existing (pre-Task-6) coverage for the session-timer alarm functions - restored here after
// a Task 6 fix-round-1 review caught that this file had been overwritten wholesale rather than
// extended, silently dropping this describe block. See the "friend-poll alarm is independent of
// the session-timer alarm" block below for the functions Task 6 actually added.
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

// v2 Task 12: the temp-unlock-relock alarm - deliberately its own name/prefix, independent of
// both the session-timer and friend-poll alarms (must fire regardless of friend-sync/group
// eligibility, per this task's brief), and named PER HOSTNAME (a prefix match, not a single fixed
// name like the other two alarms) since more than one hostname could have an active temp-unlock
// at once.
describe("temp-unlock-relock alarm is independent of, and named differently from, the other two alarms", () => {
  it("scheduleTempUnlockRelockAlarm creates an alarm named with the hostname suffix, at the given timestamp, without touching the other two alarms", async () => {
    scheduleTempUnlockRelockAlarm("youtube.com", 50_000);

    const alarm = await chrome.alarms.get("snufflestudy-temp-unlock-relock-youtube.com");
    expect(alarm?.scheduledTime).toBe(50_000);
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeUndefined();
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeUndefined();
  });

  it("schedules independent alarms for different hostnames simultaneously", async () => {
    scheduleTempUnlockRelockAlarm("youtube.com", 50_000);
    scheduleTempUnlockRelockAlarm("reddit.com", 60_000);

    expect((await chrome.alarms.get("snufflestudy-temp-unlock-relock-youtube.com"))?.scheduledTime).toBe(
      50_000
    );
    expect((await chrome.alarms.get("snufflestudy-temp-unlock-relock-reddit.com"))?.scheduledTime).toBe(
      60_000
    );
  });

  it("re-scheduling the same hostname replaces its alarm's expiry rather than creating a second one", async () => {
    scheduleTempUnlockRelockAlarm("youtube.com", 50_000);
    scheduleTempUnlockRelockAlarm("youtube.com", 90_000);

    const alarm = await chrome.alarms.get("snufflestudy-temp-unlock-relock-youtube.com");
    expect(alarm?.scheduledTime).toBe(90_000);
  });

  it("cancelTempUnlockRelockAlarm clears only the named hostname's alarm, leaving another hostname's and the other two alarms untouched", async () => {
    scheduleSessionAlarm(Date.now() + 60_000);
    scheduleFriendPollAlarm();
    scheduleTempUnlockRelockAlarm("youtube.com", 50_000);
    scheduleTempUnlockRelockAlarm("reddit.com", 60_000);

    cancelTempUnlockRelockAlarm("youtube.com");

    expect(await chrome.alarms.get("snufflestudy-temp-unlock-relock-youtube.com")).toBeUndefined();
    expect(await chrome.alarms.get("snufflestudy-temp-unlock-relock-reddit.com")).toBeDefined();
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeDefined();
    expect(await chrome.alarms.get("snufflestudy-friend-poll")).toBeDefined();
  });

  it("isTempUnlockRelockAlarm matches by prefix (any hostname) and rejects the other two alarm names", () => {
    expect(
      isTempUnlockRelockAlarm({ name: "snufflestudy-temp-unlock-relock-youtube.com" } as chrome.alarms.Alarm)
    ).toBe(true);
    expect(
      isTempUnlockRelockAlarm({ name: "snufflestudy-temp-unlock-relock-a.b.co.uk" } as chrome.alarms.Alarm)
    ).toBe(true);
    expect(isTempUnlockRelockAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm)).toBe(
      false
    );
    expect(isTempUnlockRelockAlarm({ name: "snufflestudy-friend-poll" } as chrome.alarms.Alarm)).toBe(
      false
    );
  });

  it("hostnameFromTempUnlockRelockAlarm parses the hostname back out of the alarm name", () => {
    expect(
      hostnameFromTempUnlockRelockAlarm({
        name: "snufflestudy-temp-unlock-relock-youtube.com",
      } as chrome.alarms.Alarm)
    ).toBe("youtube.com");
  });
});
