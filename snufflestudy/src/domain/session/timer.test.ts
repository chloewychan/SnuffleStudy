import { describe, it, expect } from "vitest";
import { remainingSeconds, isTimerExpired } from "./timer";
import * as machine from "./sessionMachine";
import type { CreateSessionInput } from "./sessionTypes";

const input: CreateSessionInput = {
  goal: "Read chapters 3 and 4",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("timer", () => {
  it("computes remaining seconds while FOCUSING from plannedEndAt, not a stored counter", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    expect(remainingSeconds(started, 400_000)).toBe(1100);
  });

  it("survives a simulated browser restart — remaining time is derived, not stored state", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    // Simulate reading the same session object back after the service worker
    // was killed and restarted 10 minutes later — no special restore logic needed.
    expect(remainingSeconds(started, 600_000)).toBe(900);
  });

  it("returns the saved remainingSeconds while PAUSED", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const paused = machine.pauseSession(started, 400_000);
    expect(remainingSeconds(paused, 999_999_999)).toBe(1100);
  });

  it("computes remaining seconds from breakEndsAt while on BREAK", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const onBreak = machine.startBreak(started, 0);
    expect(remainingSeconds(onBreak, 100_000)).toBe(200);
  });

  it("never returns a negative value", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    expect(remainingSeconds(started, 999_999_999)).toBe(0);
  });

  it("returns 0 for a session with no active timer", () => {
    const created = machine.createSession(input, "session_1", 0);
    expect(remainingSeconds(created, 0)).toBe(0);
  });

  it("reports isTimerExpired correctly for FOCUSING", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    expect(isTimerExpired(started, 1500 * 1000 - 1)).toBe(false);
    expect(isTimerExpired(started, 1500 * 1000)).toBe(true);
  });
});
