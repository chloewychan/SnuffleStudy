import type { StudySession } from "../../domain/session/sessionTypes";

interface SessionStatusCardProps {
  session: StudySession;
}

type Tier = "ok" | "caution" | "danger";

// Two independent indicators, deliberately not cross-wired: activityState reflects
// system-wide keyboard/mouse activity (chrome.idle, via idleHandlers.ts), interventionLevel
// reflects distraction/warning level (tabHandlers.ts). A future signal could feed into
// interventionLevel without this component needing to change.
const ACTIVITY_TIER: Record<StudySession["activityState"], Tier> = {
  active: "ok",
  idle: "caution",
  locked: "danger",
};

const ACTIVITY_LABELS: Record<StudySession["activityState"], string> = {
  active: "Active",
  idle: "Idle",
  locked: "Locked",
};

const DISTRACTION_TIER: Record<StudySession["interventionLevel"], Tier> = {
  none: "ok",
  warned: "caution",
  escalated: "danger",
};

const DISTRACTION_LABELS: Record<StudySession["interventionLevel"], string> = {
  none: "On track",
  warned: "Warned",
  escalated: "Escalated",
};

export function SessionStatusCard({ session }: SessionStatusCardProps) {
  return (
    <div className="session-status-card">
      <p className="session-status-card__goal">{session.goal}</p>
      <p className="session-status-card__state">{session.state}</p>
      <div className="session-status-card__indicators">
        <span className="session-status-card__indicator">
          <span
            className="session-status-card__dot"
            data-tier={ACTIVITY_TIER[session.activityState]}
            aria-hidden="true"
          />
          Activity: {ACTIVITY_LABELS[session.activityState]}
        </span>
        <span className="session-status-card__indicator">
          <span
            className="session-status-card__dot"
            data-tier={DISTRACTION_TIER[session.interventionLevel]}
            aria-hidden="true"
          />
          Focus: {DISTRACTION_LABELS[session.interventionLevel]}
        </span>
      </div>
      {session.distractionAttempts > 0 && (
        <p className="session-status-card__distractions">
          {session.distractionAttempts} distraction attempt
          {session.distractionAttempts === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
