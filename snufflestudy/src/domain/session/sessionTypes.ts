export type SessionState =
  | "IDLE"
  | "SESSION_SETUP"
  | "FOCUSING"
  | "PAUSED"
  | "BREAK"
  | "COMPLETED"
  | "ABANDONED";

export type InterventionLevel = "none" | "warned" | "escalated";

export type RestrictionMode = "soft" | "hard";

export interface StudySession {
  id: string;
  goal: string;
  state: SessionState;
  interventionLevel: InterventionLevel;

  createdAt: number;
  startedAt?: number;
  plannedEndAt?: number;
  pausedAt?: number;
  breakStartedAt?: number;
  breakEndsAt?: number;
  completedAt?: number;
  endedAt?: number;

  focusDurationSeconds: number;
  breakDurationSeconds: number;
  remainingSeconds?: number;

  pressureProfileId: string;
  allowedSites: string[];
  restrictedSites: string[];
  restrictionMode: RestrictionMode;
  siteRestrictionOverrides?: Record<string, RestrictionMode>;

  accountabilityGroupId?: string;
  accountabilityUserIds: string[];

  distractionAttempts: number;
  recoveries: number;
  friendNudges: number;
}

export interface CreateSessionInput {
  goal: string;
  focusDurationSeconds: number;
  breakDurationSeconds: number;
  pressureProfileId: string;
  allowedSites: string[];
  restrictedSites: string[];
  restrictionMode: RestrictionMode;
  siteRestrictionOverrides?: Record<string, RestrictionMode>;
}

export type SessionEventType =
  | "SESSION_CREATED"
  | "SESSION_STARTED"
  | "SESSION_PAUSED"
  | "SESSION_RESUMED"
  | "SESSION_BREAK_STARTED"
  | "SESSION_BREAK_ENDED"
  | "DISTRACTION_ATTEMPT"
  | "SITE_MARKED_STUDY_RELATED"
  | "HARD_BLOCK_UNLOCK"
  | "RECOVERY"
  | "SESSION_COMPLETED"
  | "SESSION_ABANDONED";

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: SessionEventType;
  occurredAt: number;
  hostname?: string;
  reason?: string;
}

export interface HistoryQuery {
  limit?: number;
  since?: number;
  state?: SessionState;
}
