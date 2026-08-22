import { useEffect, useState } from "react";
import { SessionStatusCard } from "../../shared/ui/SessionStatusCard";
import { TimerRing } from "../../shared/ui/TimerRing";
import { PauseResumeControl } from "../../shared/ui/PauseResumeControl";
import { EndSessionControl } from "../../shared/ui/EndSessionControl";
import { useNow } from "../../popup/hooks/useNow";
import { remainingSeconds as computeRemainingSeconds } from "../../domain/session/timer";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { NUDGE_MESSAGES } from "../../domain/accountability/nudgeMessages";
import type { StudySession } from "../../domain/session/sessionTypes";
import type { GroupMembership } from "../../infrastructure/backend/friendGroupApi";

// Minimal shape of AUTH_GET_SESSION's response this component needs - mirrors the same minimal
// AuthUser/AuthSession shape duplicated in Header.tsx, AccountPage.tsx, and FriendGroupPanel.tsx.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

// First entry of the fixed NUDGE_MESSAGES catalog, used as this panel's default nudge text (a
// friend can only pick from FriendGroupPanel's full picker - this Study Room panel sends the
// same "encouraging check-in" every time, matching the Figma mock's single Nudge button per
// friend rather than a full message picker). The `?? "keep-going"` fallback exists only to
// satisfy the indexed-access type check (NUDGE_MESSAGES is a static 6-entry array, never empty
// at runtime) - not a real runtime concern.
const DEFAULT_NUDGE_MESSAGE_ID = NUDGE_MESSAGES[0]?.id ?? "keep-going";

interface ActiveSessionViewProps {
  session: StudySession;
  onShowUnlockPanel: () => void;
  onShowTempPasscodePanel: () => void;
}

// Task 9: replaces SidePanelApp.tsx's inline active-session branch (SessionStatusCard/TimerRing/
// restricted-sites-list/PauseResumeControl/EndSessionControl, plus the two showUnlockPanel/
// showTempPasscodePanel trigger buttons) with a standalone component matching the Figma "Study
// Session" screen (get_design_context on nodeId=60:774 was attempted first per the task brief but
// hit this project's exhausted Figma MCP "Starter plan" quota - see the task report for the raw
// structural fallback metadata this was built from instead).
//
// StudySession has no room/roomId field - only accountabilityGroupId/accountabilityUserIds - so
// the Figma mock's "Study Room" panel (friend list + Nudge) is built here against the session's
// accountability group via GROUP_LIST_MEMBERS, not LiveKit's StudyRoom. "Send Producer Tag" from
// the same mock is deliberately NOT implemented here: it would need the same record/upload/send
// flow ProducerTagRecorder + producerTagApi already provide inside FriendGroupPanel, and this
// plan's Global Constraint against adding new message types means it should reuse that exact
// existing pattern rather than invent one - left as a candidate follow-up task, not stubbed here.
export function ActiveSessionView({
  session,
  onShowUnlockPanel,
  onShowTempPasscodePanel,
}: ActiveSessionViewProps) {
  const now = useNow();
  const remaining = computeRemainingSeconds(session, now);
  // Preserves the original inline branch's BREAK-aware denominator (SidePanelApp.tsx: `session
  // .state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds`) - always
  // using focusDurationSeconds here would make TimerRing's progress ring wrong (and read as
  // 100%+ remaining) during a break.
  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  const [members, setMembers] = useState<GroupMembership[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [nudgingUserId, setNudgingUserId] = useState<string | null>(null);
  const [nudgeError, setNudgeError] = useState<string | null>(null);
  // Fix 4 (final-review fix wave): the current user is themselves a member of their own
  // accountability group, so GROUP_LIST_MEMBERS' unfiltered rows would otherwise include a "Nudge
  // yourself" row. Resolved the same way FriendGroupPanel.tsx's loadFriends() already does (via
  // AUTH_GET_SESSION), then filtered out of the rendered list below.
  const [selfUserId, setSelfUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sendMessage<{ ok: boolean; session?: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setSelfUserId(res.session?.user.id ?? null);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — same rationale as the
        // GROUP_LIST_MEMBERS fetch below. Not resolving the current user's id just means the
        // self-filter below is a no-op (self may render as a nudge target) - not a crash.
        if (cancelled) return;
        console.error("Failed to resolve current user for study room filtering", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session.accountabilityGroupId) return;
    let cancelled = false;
    setMembersError(null);

    sendMessage<{ ok: boolean; members?: GroupMembership[]; error?: string }>({
      type: "GROUP_LIST_MEMBERS",
      payload: { groupId: session.accountabilityGroupId },
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.members) {
          setMembersError(res.error ?? "Could not load your study room.");
          return;
        }
        setMembers(res.members);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject - e.g. "Could not establish
        // connection..." during service-worker startup races, or extension-context-invalidated.
        // Surfaced via membersError rather than left as an unhandled rejection.
        if (cancelled) return;
        console.error("Failed to load study room members", err);
        setMembersError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [session.accountabilityGroupId]);

  // NUDGE_SEND requires a specific friendUserId (src/shared/messages.ts), not a bulk action, so
  // this renders one Nudge button per study-room member rather than the Figma mock's single
  // representative button - a deliberate adaptation to the real message shape, not a copy of the
  // mock's exact button count (see this task's brief).
  function nudge(friendUserId: string) {
    setNudgingUserId(friendUserId);
    setNudgeError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "NUDGE_SEND",
      payload: { friendUserId, messageId: DEFAULT_NUDGE_MESSAGE_ID },
    })
      .then((res) => {
        if (!res.ok) {
          // Server-side rejection (toggle off or cooldown - see nudgeApi.ts/can_send_nudge()),
          // surfaced inline rather than silently swallowed - mirrors FriendGroupPanel.tsx's own
          // handleSendNudge.
          setNudgeError(res.error ?? "Could not send that nudge.");
        }
      })
      .catch((err) => {
        console.error("Failed to send nudge", err);
        setNudgeError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setNudgingUserId(null));
  }

  // Fix 4: exclude the current user from their own study room's nudge-able list - see
  // FriendGroupPanel.tsx's identical `member.userId !== userId` filter in loadFriends().
  const nudgeableMembers = members.filter((member) => member.userId !== selfUserId);

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

      <section className="sp-card sp-active-session__room">
        {/* The group's display name (friendGroupApi.ts's FriendGroup.name) isn't part of this
            task's Consumes list (only GROUP_LIST_MEMBERS/NUDGE_SEND) and GROUP_LIST_MEMBERS
            itself returns bare GroupMembership rows with no name field - so this reads "Study
            Room" generically rather than the Figma mock's group-name-interpolated title. */}
        <h3 className="sp-card__title">Study Room</h3>
        {membersError && (
          <p role="alert">Couldn't load your study room: {membersError}.</p>
        )}
        {nudgeableMembers.length === 0 && !membersError && <p>No one else in your study room yet.</p>}
        {nudgeableMembers.length > 0 && (
          <ul className="sp-active-session__friend-list">
            {nudgeableMembers.map((member) => (
              <li key={member.userId}>
                {/* No `profiles` table exists yet (see friendGroupApi.ts's listMembers()
                    comment), so members are identified by raw user id - same convention already
                    established by FriendGroupPanel.tsx/DigestCard/IncomingNudgeCard. */}
                <span>Friend {member.userId}</span>
                <button
                  type="button"
                  onClick={() => nudge(member.userId)}
                  disabled={nudgingUserId === member.userId}
                >
                  Nudge {member.userId}
                </button>
              </li>
            ))}
          </ul>
        )}
        {nudgeError && <p role="alert">Nudge not sent: {nudgeError}.</p>}
      </section>

      <div className="sp-active-session__escape-hatches">
        <button type="button" onClick={onShowUnlockPanel}>
          Unlock requests
        </button>
        <button type="button" onClick={onShowTempPasscodePanel}>
          Temp passcode requests
        </button>
      </div>
    </div>
  );
}
