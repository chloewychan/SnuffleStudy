import { useEffect, useState } from "react";
import { SessionStatusCard } from "../../shared/ui/SessionStatusCard";
import { TimerRing } from "../../shared/ui/TimerRing";
import { PauseResumeControl } from "../../shared/ui/PauseResumeControl";
import { EndSessionControl } from "../../shared/ui/EndSessionControl";
import { useNow } from "../../shared/hooks/useNow";
import { remainingSeconds as computeRemainingSeconds } from "../../domain/session/timer";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { NUDGE_MESSAGES } from "../../domain/accountability/nudgeMessages";
import type { StudySession } from "../../domain/session/sessionTypes";

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
// StudySession has no room/roomId field - only accountabilityGroupId/accountabilityUserIds - so
// the Figma mock's "Study Room" panel (friend list + Nudge) is built here against the session's
// accountability group (v3.4 Task 2: via FRIENDS_LIST, not LiveKit's StudyRoom - see this file's FRIENDS_LIST comment below for why this fetch is unreachable in practice anyway). "Send Producer Tag" from
// the same mock is deliberately NOT implemented here: it would need the same record/upload/send
// flow ProducerTagRecorder + producerTagApi already provide inside FriendGroupPanel, and this
// plan's Global Constraint against adding new message types means it should reuse that exact
// existing pattern rather than invent one - left as a candidate follow-up task, not stubbed here.
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

  const [members, setMembers] = useState<string[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [nudgingUserId, setNudgingUserId] = useState<string | null>(null);
  const [nudgeError, setNudgeError] = useState<string | null>(null);
  // Fix 4 (final-review fix wave): the current user is themselves a member of their own
  // accountability group, so an unfiltered friend list would otherwise include a "Nudge
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
        // FRIENDS_LIST fetch below. Not resolving the current user's id just means the
        // self-filter below is a no-op (self may render as a nudge target) - not a crash.
        if (cancelled) return;
        console.error("Failed to resolve current user for study room filtering", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // v3.4 Task 2: GROUP_LIST_MEMBERS/group_memberships are gone (supabase/migrations/
  // 20260815000040_v3.4_friendships.sql) - this fetch now calls FRIENDS_LIST instead. Note this
  // was already effectively unreachable before this task: session.accountabilityGroupId
  // (sessionTypes.ts) has no live producer anywhere in the codebase (nothing sets it on session
  // creation), so this guard is always false in practice today. Left exactly as it was
  // (session.accountabilityGroupId-gated) rather than redesigned - reworking this "Study Room"
  // section to source from the real friendship model is Task 3/a future task's concern, not this
  // one's; this is the minimal mechanical fix needed to keep this file compiling and behaving
  // identically (still unreachable) now that its old backing table/message no longer exist.
  useEffect(() => {
    if (!session.accountabilityGroupId) return;
    let cancelled = false;
    setMembersError(null);

    sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({
      type: "FRIENDS_LIST",
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setMembersError(res.error ?? "Could not load your study room.");
          return;
        }
        setMembers(res.friendIds ?? []);
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
  // FriendGroupPanel.tsx's identical self-filter in loadFriends().
  const nudgeableMembers = members.filter((memberId) => memberId !== selfUserId);

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
        {/* No group display name exists to interpolate (the group mechanic is gone - v3.4 Task
            2), so this reads "Study Room" generically rather than the Figma mock's
            group-name-interpolated title, same as before this task. */}
        <h3 className="sp-card__title">Study Room</h3>
        {membersError && (
          <p role="alert">Couldn't load your study room: {membersError}.</p>
        )}
        {nudgeableMembers.length === 0 && !membersError && <p>No one else in your study room yet.</p>}
        {nudgeableMembers.length > 0 && (
          <ul className="sp-active-session__friend-list">
            {nudgeableMembers.map((memberId) => (
              <li key={memberId}>
                {/* No `profiles`-based name resolution here - members are identified by raw user
                    id, same convention already established by FriendGroupPanel.tsx/DigestCard/
                    IncomingNudgeCard. */}
                <span>Friend {memberId}</span>
                <button
                  type="button"
                  onClick={() => nudge(memberId)}
                  disabled={nudgingUserId === memberId}
                >
                  Nudge {memberId}
                </button>
              </li>
            ))}
          </ul>
        )}
        {nudgeError && <p role="alert">Nudge not sent: {nudgeError}.</p>}
      </section>

      <div className="sp-active-session__escape-hatches">
        <button type="button" onClick={onShowFriendRequestPanel}>
          Friend requests
        </button>
      </div>
    </div>
  );
}
