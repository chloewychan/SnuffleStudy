import type { StudySession } from "../../domain/session/sessionTypes";

interface SessionStatusCardProps {
  session: StudySession;
}

export function SessionStatusCard({ session }: SessionStatusCardProps) {
  return (
    <div className="session-status-card">
      <p className="session-status-card__goal">{session.goal}</p>
      <p className="session-status-card__state">{session.state}</p>
      {session.distractionAttempts > 0 && (
        <p className="session-status-card__distractions">
          {session.distractionAttempts} distraction attempt
          {session.distractionAttempts === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
