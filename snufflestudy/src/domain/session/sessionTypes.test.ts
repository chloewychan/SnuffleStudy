import { describe, it, expect } from "vitest";
import type {
  StudySession,
  CreateSessionInput,
  SessionEvent,
} from "./sessionTypes";

describe("sessionTypes", () => {
  it("accepts a fully-formed StudySession object", () => {
    const session: StudySession = {
      id: "session_1",
      goal: "Finish 20 chemistry problems",
      state: "FOCUSING",
      interventionLevel: "none",
      activityState: "active",
      createdAt: 1000,
      startedAt: 1000,
      plannedEndAt: 2000,
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "strict-coach",
      allowedSites: ["docs.google.com"],
      restrictedSites: ["youtube.com"],
      restrictionMode: "soft",
      accountabilityUserIds: [],
      distractionAttempts: 0,
      recoveries: 0,
      friendNudges: 0,
    };

    expect(session.state).toBe("FOCUSING");
  });

  it("accepts a minimal CreateSessionInput", () => {
    const input: CreateSessionInput = {
      goal: "Read chapters 3 and 4",
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "gentle-encouragement",
      allowedSites: [],
      restrictedSites: [],
      restrictionMode: "soft",
    };

    expect(input.restrictionMode).toBe("soft");
  });

  it("accepts a SessionEvent", () => {
    const event: SessionEvent = {
      id: "event_1",
      sessionId: "session_1",
      type: "DISTRACTION_ATTEMPT",
      occurredAt: 1500,
      hostname: "youtube.com",
    };

    expect(event.type).toBe("DISTRACTION_ATTEMPT");
  });
});
