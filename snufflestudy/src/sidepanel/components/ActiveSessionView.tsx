import { useNow } from "../../shared/hooks/useNow";
import { SessionStatusCard } from "../../shared/ui/SessionStatusCard";
import { TimerRing } from "../../shared/ui/TimerRing";
import { PauseResumeControl } from "../../shared/ui/PauseResumeControl";
import { EndSessionControl } from "../../shared/ui/EndSessionControl";
import { remainingSeconds as computeRemainingSeconds } from "../../domain/session/timer";
import type { StudySession } from "../../domain/session/sessionTypes";

interface ActiveSessionViewProps {
  session: StudySession;
  // v3.4 Task 3: replaces the two separate onShowUnlockPanel/onShowTempPasscodePanel callbacks
  // (v2 Task 8/Task 12) with one - unlock_requests/temp_passcode_requests/session_end_requests
  // are now one friend_requests table behind one FriendRequestPanel.tsx (composed alongside the
  // new RequestUnlockForm.tsx at SidePanelApp.tsx's active-session call site), so there's only
  // one panel to reveal.
  onShowFriendRequestPanel: () => void;
}

// Task 9: replaces SidePanelApp.tsx's inline active-session branch (SessionStatusCard/TimerRing/
// restricted-sites-list/PauseResumeControl/EndSessionControl, plus the two showUnlockPanel/
// showTempPasscodePanel trigger buttons) with a standalone component matching the Figma "Study
// Session" screen (get_design_context on nodeId=60:774 was attempted first per the task brief but
// hit this project's exhausted Figma MCP "Starter plan" quota - see the task report for the raw
// structural fallback metadata this was built from instead).
//
// v4.1 Task 7 (Decision 4): this file used to also render a "Study Room" section here - a
// participant list + one Nudge button per accountability-group member, gated on
// session.accountabilityGroupId. That field has no producer anywhere in the codebase (nothing
// ever sets it on session creation), so the section never actually rendered. Removed entirely
// rather than left in place, dead, alongside the new persistent Study Room footer
// (StudyRoomFooter.tsx via AppFooter.tsx) - keeping two different "Study Room during a session"
// implementations in one file, one of them permanently unreachable, would only confuse a future
// reader. The "Friend requests" escape-hatch button below is untouched (Task 8 changes what it
// does, not this task).
export function ActiveSessionView({
  session,
  onShowFriendRequestPanel,
}: ActiveSessionViewProps) {
  const now = useNow();
  const remaining = computeRemainingSeconds(session, now);
  // Preserves the original inline branch's BREAK-aware denominator (SidePanelApp.tsx: `session
  // .state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds`) - always
  // using focusDurationSeconds here would make TimerRing's progress ring wrong (and read as
  // 100%+ remaining) during a break.
  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="sp-tab-content sp-active-session">
      {/* Figma node 60:783 ("Example Goal Name") sits above the "Study Session in Progress"
          card (Group 17, node 62:1003) as its own standalone headline - kept as a separate
          element here rather than folded away, even though the reused, unmodified
          SessionStatusCard below also renders session.goal itself (its own
          session-status-card__goal paragraph). That duplication is an accepted, documented
          consequence of composing an already-built component rather than a bug - see
          FriendsTab.tsx for the same "reuse composed components as-is, document any resulting
          mismatch" precedent from Task 7. */}
      <h2 className="sp-active-session__goal">{session.goal}</h2>

      <section className="sp-card sp-active-session__progress">
        <TimerRing remainingSeconds={remaining} totalSeconds={totalSeconds} />
        <h3 className="sp-card__title">Study Session in Progress</h3>
        <div className="sp-active-session__controls">
          <PauseResumeControl session={session} />
          <EndSessionControl session={session} />
        </div>
        <SessionStatusCard session={session} />
        {/* Restricted-sites list, lifted from the original inline SidePanelApp.tsx active-session
            branch - not part of the Figma mock's trimmed metadata, but functionally needed and
            explicitly called out in this task's own description as part of what's being
            replaced. */}
        {session.restrictedSites.length > 0 && (
          <ul className="sp-active-session__sites">
            {session.restrictedSites.map((site) => (
              <li key={site}>{site}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="sp-active-session__escape-hatches">
        <button type="button" onClick={onShowFriendRequestPanel}>
          Friend requests
        </button>
      </div>
    </div>
  );
}
