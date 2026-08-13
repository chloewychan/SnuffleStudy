import type { CreateSessionInput, StudySession } from "./sessionTypes";

export function createSession(
  input: CreateSessionInput,
  id: string,
  now: number
): StudySession {
  return {
    id,
    goal: input.goal,
    state: "SESSION_SETUP",
    interventionLevel: "none",
    activityState: "active",
    createdAt: now,
    focusDurationSeconds: input.focusDurationSeconds,
    breakDurationSeconds: input.breakDurationSeconds,
    pressureProfileId: input.pressureProfileId,
    allowedSites: input.allowedSites,
    restrictedSites: input.restrictedSites,
    restrictionMode: input.restrictionMode,
    siteRestrictionOverrides: input.siteRestrictionOverrides,
    accountabilityUserIds: [],
    distractionAttempts: 0,
    recoveries: 0,
    friendNudges: 0,
  };
}

export function startSession(session: StudySession, now: number): StudySession {
  if (session.state !== "SESSION_SETUP") {
    throw new Error(`Cannot start a session in state ${session.state}`);
  }
  return {
    ...session,
    state: "FOCUSING",
    startedAt: now,
    plannedEndAt: now + session.focusDurationSeconds * 1000,
  };
}

export function pauseSession(session: StudySession, now: number): StudySession {
  if (session.state !== "FOCUSING") {
    throw new Error(`Cannot pause a session in state ${session.state}`);
  }
  const remainingSeconds = Math.max(
    0,
    Math.round(((session.plannedEndAt ?? now) - now) / 1000)
  );
  return {
    ...session,
    state: "PAUSED",
    pausedAt: now,
    remainingSeconds,
    plannedEndAt: undefined,
  };
}

export function resumeSession(session: StudySession, now: number): StudySession {
  if (session.state !== "PAUSED") {
    throw new Error(`Cannot resume a session in state ${session.state}`);
  }
  const remainingSeconds = session.remainingSeconds ?? session.focusDurationSeconds;
  return {
    ...session,
    state: "FOCUSING",
    pausedAt: undefined,
    plannedEndAt: now + remainingSeconds * 1000,
    remainingSeconds: undefined,
  };
}

export function startBreak(session: StudySession, now: number): StudySession {
  if (session.state !== "FOCUSING") {
    throw new Error(`Cannot start a break from state ${session.state}`);
  }
  return {
    ...session,
    state: "BREAK",
    breakStartedAt: now,
    breakEndsAt: now + session.breakDurationSeconds * 1000,
    plannedEndAt: undefined,
  };
}

export function endBreak(session: StudySession, now: number): StudySession {
  if (session.state !== "BREAK") {
    throw new Error(`Cannot end a break from state ${session.state}`);
  }
  return {
    ...session,
    state: "FOCUSING",
    breakStartedAt: undefined,
    breakEndsAt: undefined,
    plannedEndAt: now + session.focusDurationSeconds * 1000,
  };
}

export function completeSession(session: StudySession, now: number): StudySession {
  if (session.state !== "FOCUSING") {
    throw new Error(`Cannot complete a session in state ${session.state}`);
  }
  return { ...session, state: "COMPLETED", completedAt: now, endedAt: now };
}

export function abandonSession(session: StudySession, now: number): StudySession {
  if (session.state === "COMPLETED" || session.state === "ABANDONED") {
    throw new Error(`Cannot abandon a session in state ${session.state}`);
  }
  return { ...session, state: "ABANDONED", endedAt: now };
}

export function warnSession(session: StudySession): StudySession {
  if (session.interventionLevel === "escalated") return session;
  return { ...session, interventionLevel: "warned" };
}

export function escalateSession(session: StudySession): StudySession {
  return { ...session, interventionLevel: "escalated" };
}

export function clearIntervention(session: StudySession): StudySession {
  return { ...session, interventionLevel: "none" };
}

export function setActivityState(
  session: StudySession,
  activityState: StudySession["activityState"]
): StudySession {
  return { ...session, activityState };
}

export function recordDistractionAttempt(session: StudySession): StudySession {
  return { ...session, distractionAttempts: session.distractionAttempts + 1 };
}

export function recordRecovery(session: StudySession): StudySession {
  return {
    ...session,
    recoveries: session.recoveries + 1,
    interventionLevel: "none",
  };
}
