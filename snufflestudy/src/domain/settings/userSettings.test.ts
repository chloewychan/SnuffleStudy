import { describe, it, expect } from "vitest";
import { DEFAULT_USER_SETTINGS, isWithinQuietHours } from "./userSettings";

describe("DEFAULT_USER_SETTINGS — v2 Task 10 Part C notification-preference fields", () => {
  it("defaults live-nudge and digest notifications to enabled, and quiet hours to unconfigured", () => {
    expect(DEFAULT_USER_SETTINGS.liveNudgesNotificationsEnabled).toBe(true);
    expect(DEFAULT_USER_SETTINGS.digestNotificationsEnabled).toBe(true);
    expect(DEFAULT_USER_SETTINGS.quietHours).toBeNull();
  });
});

describe("isWithinQuietHours", () => {
  it("returns false when no quiet-hours window is configured", () => {
    expect(isWithinQuietHours(null, new Date("2026-01-01T23:00:00"))).toBe(false);
  });

  it("returns true for an hour inside a same-day window (does not wrap midnight)", () => {
    const window = { startHour: 9, endHour: 17 };
    expect(isWithinQuietHours(window, new Date("2026-01-01T12:00:00"))).toBe(true);
  });

  it("returns false for an hour outside a same-day window", () => {
    const window = { startHour: 9, endHour: 17 };
    expect(isWithinQuietHours(window, new Date("2026-01-01T08:00:00"))).toBe(false);
    expect(isWithinQuietHours(window, new Date("2026-01-01T17:00:00"))).toBe(false);
  });

  it("is inclusive of startHour and exclusive of endHour", () => {
    const window = { startHour: 9, endHour: 17 };
    expect(isWithinQuietHours(window, new Date("2026-01-01T09:00:00"))).toBe(true);
    expect(isWithinQuietHours(window, new Date("2026-01-01T16:59:00"))).toBe(true);
  });

  it("wraps past midnight when startHour > endHour", () => {
    const window = { startHour: 22, endHour: 7 };
    expect(isWithinQuietHours(window, new Date("2026-01-01T23:00:00"))).toBe(true);
    expect(isWithinQuietHours(window, new Date("2026-01-01T03:00:00"))).toBe(true);
    expect(isWithinQuietHours(window, new Date("2026-01-01T12:00:00"))).toBe(false);
  });

  it("treats startHour === endHour as no restriction (not always-quiet or never-quiet)", () => {
    const window = { startHour: 10, endHour: 10 };
    expect(isWithinQuietHours(window, new Date("2026-01-01T10:00:00"))).toBe(false);
    expect(isWithinQuietHours(window, new Date("2026-01-01T15:00:00"))).toBe(false);
  });

  it("defaults to the current time when no date is given", () => {
    // Just confirms it doesn't throw and returns a boolean - not asserting a specific value,
    // since "now" is real wall-clock time here.
    expect(typeof isWithinQuietHours({ startHour: 0, endHour: 1 })).toBe("boolean");
  });
});
