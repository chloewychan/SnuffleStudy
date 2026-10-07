import { useNow } from "../../shared/hooks/useNow";
import { SessionStatusCard } from "../../shared/ui/SessionStatusCard";
import { TimerRing } from "../../shared/ui/TimerRing";
import { PauseResumeControl } from "../../shared/ui/PauseResumeControl";
import { EndSessionControl } from "../../shared/ui/EndSessionControl";
import { remainingSeconds as computeRemainingSeconds } from "../../domain/session/timer";
import type { StudySession } from "../../domain/session/sessionTypes";

interface ActiveSessionViewProps {
  session: StudySession;
}

// Renders the active-session screen: timer, pause/resume and end-session controls, and the
// restricted-sites list for the current session. Study Room participation and friend-request
// approval are handled elsewhere (the persistent Study Room and Nudges & Unlock Requests
// footers), not inline here. RequestUnlockForm renders alongside this component at the
// active-session call site rather than being composed inside it.
export function ActiveSessionView({ session }: ActiveSessionViewProps) {
  const now = useNow();
  const remaining = computeRemainingSeconds(session, now);
  // Use breakDurationSeconds (not focusDurationSeconds) as the denominator during a break, so
  // TimerRing's progress ring reflects the correct remaining-time total instead of reading as
  // 100%+ remaining.
  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="sp-tab-content sp-active-session">
      {/* The goal is intentionally shown twice: once as this screen's own headline, and again
          inside SessionStatusCard below (its own session-status-card__goal paragraph). The
          duplication is accepted as a consequence of reusing SessionStatusCard as-is rather
          than a bug. */}
      <h2 className="sp-active-session__goal">{session.goal}</h2>

      <section className="sp-card sp-active-session__progress">
        <h3 className="sp-card__title">Study Session in Progress</h3>
        <div className="sp-active-session__timer-row">
          <TimerRing remainingSeconds={remaining} totalSeconds={totalSeconds} />
          <div className="sp-active-session__controls">
            <PauseResumeControl session={session} />
            <EndSessionControl session={session} />
          </div>
        </div>
        <SessionStatusCard session={session} />
        {/* Restricted-sites list - not part of the design mockup, but needed functionally. */}
        {session.restrictedSites.length > 0 && (
          <ul className="sp-active-session__sites">
            {session.restrictedSites.map((site) => (
              <li key={site}>{site}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
