import { describe, it, expect } from "vitest";
import * as machine from "./sessionMachine";
import type { CreateSessionInput } from "./sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
};

describe("sessionMachine", () => {
  it("creates a session in SESSION_SETUP", () => {
    const session = machine.createSession(input, "session_1", 1000);
    expect(session.state).toBe("SESSION_SETUP");
    expect(session.interventionLevel).toBe("none");
    expect(session.distractionAttempts).toBe(0);
  });

  it("starts a session and computes plannedEndAt", () => {
    const created = machine.createSession(input, "session_1", 1000);
    const started = machine.startSession(created, 1000);
    expect(started.state).toBe("FOCUSING");
    expect(started.plannedEndAt).toBe(1000 + 1500 * 1000);
  });

  it("refuses to start a session that isn't in SESSION_SETUP", () => {
    const created = machine.createSession(input, "session_1", 1000);
    const started = machine.startSession(created, 1000);
    expect(() => machine.startSession(started, 2000)).toThrow(
      "Cannot start a session in state FOCUSING"
    );
  });

  it("pauses and resumes, preserving remaining time", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const paused = machine.pauseSession(started, 400_000);
    expect(paused.state).toBe("PAUSED");
    expect(paused.remainingSeconds).toBe(1100);
    expect(paused.plannedEndAt).toBeUndefined();

    const resumed = machine.resumeSession(paused, 500_000);
    expect(resumed.state).toBe("FOCUSING");
    expect(resumed.plannedEndAt).toBe(500_000 + 1100 * 1000);
  });

  it("starts and ends a break, returning to FOCUSING with a fresh plannedEndAt", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const onBreak = machine.startBreak(started, 100_000);
    expect(onBreak.state).toBe("BREAK");
    expect(onBreak.breakEndsAt).toBe(100_000 + 300 * 1000);

    const backToFocus = machine.endBreak(onBreak, 400_000);
    expect(backToFocus.state).toBe("FOCUSING");
    expect(backToFocus.plannedEndAt).toBe(400_000 + 1500 * 1000);
  });

  it("completes a focusing session", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const completed = machine.completeSession(started, 1_500_000);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.completedAt).toBe(1_500_000);
  });

  it("abandons a session from any non-terminal state", () => {
    const created = machine.createSession(input, "session_1", 0);
    const abandoned = machine.abandonSession(created, 5000);
    expect(abandoned.state).toBe("ABANDONED");
    expect(abandoned.endedAt).toBe(5000);
  });

  it("refuses to abandon an already-terminal session", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const completed = machine.completeSession(started, 1_500_000);
    expect(() => machine.abandonSession(completed, 1_600_000)).toThrow(
      "Cannot abandon a session in state COMPLETED"
    );
  });

  it("tracks intervention level independently of session state", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const warned = machine.warnSession(started);
    expect(warned.interventionLevel).toBe("warned");
    expect(warned.state).toBe("FOCUSING");

    const paused = machine.pauseSession(warned, 100_000);
    expect(paused.interventionLevel).toBe("warned");
    expect(paused.state).toBe("PAUSED");

    const escalated = machine.escalateSession(paused);
    expect(escalated.interventionLevel).toBe("escalated");

    const cleared = machine.clearIntervention(escalated);
    expect(cleared.interventionLevel).toBe("none");
  });

  it("records distraction attempts and recoveries", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const distracted = machine.recordDistractionAttempt(machine.warnSession(started));
    expect(distracted.distractionAttempts).toBe(1);
    expect(distracted.interventionLevel).toBe("warned");

    const recovered = machine.recordRecovery(distracted);
    expect(recovered.recoveries).toBe(1);
    expect(recovered.interventionLevel).toBe("none");
  });
});
