import { useNow } from "../../shared/hooks/useNow";
import { TimerRing } from "../../shared/ui/TimerRing";
import { PauseResumeControl } from "../../shared/ui/PauseResumeControl";
import { EndSessionControl } from "../../shared/ui/EndSessionControl";
import { ACTIVITY_LABELS, DISTRACTION_LABELS } from "../../shared/ui/SessionStatusCard";
import { remainingSeconds as computeRemainingSeconds } from "../../domain/session/timer";
import type { StudySession } from "../../domain/session/sessionTypes";
import pageStyles from "../styles/frontend-backup/pages/tabs/ActiveStudySessionPage.module.css";
import styles from "../styles/frontend-backup/components/study/ActiveSession.module.css";

interface ActiveSessionViewProps {
  session: StudySession;
}

// v4.2 Task 7: re-skinned as frontend-backup's ActiveStudySessionPage.tsx (goal heading only -
// Decision 1 means its own HeaderBar/NavigationBar import+JSX is dropped, the shell already
// renders both once) + ActiveSession.tsx (the "Study Session in Progress" card). Every hook and
// piece of state below is byte-for-byte unchanged from the pre-v4.2 version - only the JSX
// return(...) block changed.
//
// Two deliberate departures from a literal transplant, both documented in the v4.2 Task 7 report:
// 1. The design's own "Study Session in Progress" card has a plain <h2>21:56</h2> time display in
//    a .timer box with no background-image asset defined anywhere in its own CSS (an incomplete
//    static export - .timer sets background-size/repeat/position but never background-image).
//    TimerRing is kept instead of that plain text: it already implements the exact
//    remaining/totalSeconds formatting this task's own Interfaces block calls out, and it carries
//    the role="timer"/aria-live="polite" accessibility attributes the Global Constraints require
//    carrying forward (the design has no accessibility semantics of its own to preserve here).
// 2. The design's two "Activity Status"/"Focus Status" rows use a static, non-interactive
//    <input type="radio"> as a decorative bullet-dot marker - there is no real user-facing choice
//    behind either one (session.activityState/interventionLevel are read-only telemetry, not
//    something a user toggles), so unlike Decision 6's actual toggles (Task Vault's per-task
//    checkbox, the tracking-tier radio pair), these become plain aria-hidden <span> markers -
//    matching SessionStatusCard.tsx's own pre-existing decorative-dot precedent - rather than a
//    functionless <input>.
export function ActiveSessionView({ session }: ActiveSessionViewProps) {
  const now = useNow();
  const remaining = computeRemainingSeconds(session, now);
  // Preserves the original inline branch's BREAK-aware denominator (SidePanelApp.tsx: `session
  // .state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds`) - always
  // using focusDurationSeconds here would make TimerRing's progress ring wrong (and read as
  // 100%+ remaining) during a break.
  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className={pageStyles.activeSessionViewRoot}>
      <h2 className={pageStyles.egGoalName}>{session.goal}</h2>

      <section className={styles.activeSession}>
        <h2 className={styles.studySessionIn}>Study Session in Progress</h2>

        <div className={styles.sessionControl}>
          <div className={styles.timer}>
            <TimerRing remainingSeconds={remaining} totalSeconds={totalSeconds} />
          </div>
          <div className={styles.buttonOptions}>
            <PauseResumeControl session={session} />
            <EndSessionControl session={session} />
          </div>
        </div>

        <div className={styles.statuses}>
          <div className={styles.activityStatus}>
            <span className={styles.buttonList} aria-hidden="true" />
            <h3 className={styles.activityStatusEg}>
              Activity Status: {ACTIVITY_LABELS[session.activityState]}
            </h3>
          </div>
          <div className={styles.activityStatus}>
            <span className={styles.buttonList} aria-hidden="true" />
            <h3 className={styles.activityStatusEg}>
              Focus Status: {DISTRACTION_LABELS[session.interventionLevel]}
            </h3>
          </div>
        </div>

        {/* Restricted-sites list, lifted from the original inline SidePanelApp.tsx active-session
            branch - not part of the design's own trimmed markup, but functionally needed (see
            file-header comment) and explicitly preserved rather than dropped. */}
        {session.restrictedSites.length > 0 && (
          <ul className={styles.restrictedSites}>
            {session.restrictedSites.map((site) => (
              <li key={site}>{site}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
