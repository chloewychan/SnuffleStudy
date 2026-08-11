import type { StudySession } from "./sessionTypes";

export function remainingSeconds(session: StudySession, now: number): number {
  if (session.state === "PAUSED") {
    return session.remainingSeconds ?? 0;
  }
  if (session.state === "FOCUSING" && session.plannedEndAt) {
    return Math.max(0, Math.round((session.plannedEndAt - now) / 1000));
  }
  if (session.state === "BREAK" && session.breakEndsAt) {
    return Math.max(0, Math.round((session.breakEndsAt - now) / 1000));
  }
  return 0;
}

export function isTimerExpired(session: StudySession, now: number): boolean {
  if (session.state === "FOCUSING" && session.plannedEndAt) {
    return now >= session.plannedEndAt;
  }
  if (session.state === "BREAK" && session.breakEndsAt) {
    return now >= session.breakEndsAt;
  }
  return false;
}
