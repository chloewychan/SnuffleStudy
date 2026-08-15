import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { FriendEvent } from "../../infrastructure/backend/sessionStatusSyncApi";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { GroupMembership } from "../../infrastructure/backend/friendGroupApi";
import { NUDGE_MESSAGES, nudgeMessageText } from "../../domain/accountability/nudgeMessages";
import { getAnimationAsset } from "../../content/overlay/animationRegistry";

interface FriendGroupPanelProps {
  onClose: () => void;
}

// Default lookback window for this panel's fetch/refresh - a point-in-time view of recent
// activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll alarm,
// which tracks its own separate "last checked" cursors via friendPollState.ts for
// chrome.notifications toasts, one for session events and one for nudges - v2 Task 7). 24h is a
// reasonable "what's been happening" window without needing its own persisted "last viewed"
// cursor. Shared by both the friend-events fetch and the incoming-nudges fetch below.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Minimal shape of what AUTH_GET_SESSION's response carries that this panel actually needs -
// mirrors AccountPage.tsx's identical minimal AuthUser/AuthSession shapes.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

// Renders one incoming nudge using the exact same visual pattern v1's SnufflesOverlay warning
// state uses (src/content/overlay/SnufflesOverlay.tsx) - same CSS classes
// ("snuffles-overlay snuffles-overlay--warning", role="alert", src/styles/global.css), same
// Snuffles image-asset mechanism (getAnimationAsset, which resolves via chrome.runtime.getURL -
// works fine in this sidepanel extension page context, not just content scripts). This is
// deliberately not the literal SnufflesOverlay component - that one is tightly coupled to
// site-restriction classification/hostname/sessionId props that don't apply to a friend's nudge -
// but the visual output should look and feel identical, not a new bespoke UI (per this task's
// brief). Only ever renders the single oldest not-yet-dismissed nudge (see FriendGroupPanel
// below) - mirrors SnufflesOverlay's own "one active warning at a time, dismissible" pattern
// rather than a stacked list, which would also visually collide given
// `.snuffles-overlay`'s `position: fixed`.
function IncomingNudgeCard({ nudge, onDismiss }: { nudge: FriendNudge; onDismiss: () => void }) {
  const asset = getAnimationAsset("study", "proud");
  const reducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  const imageSrc = reducedMotion ? asset.staticFrame : asset.frames[0];
  const messageText = nudgeMessageText(nudge.messageId) ?? "sent you a nudge.";

  return (
    <div className="snuffles-overlay snuffles-overlay--warning" role="alert">
      <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      <p>{messageText}</p>
      <p>From friend {nudge.senderUserId}</p>
      <div className="snuffles-overlay__actions">
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Shows friends' recent session status events - exactly what fetchNewEventsForFriends returns
// (event type, generic displayLabel, who, when) and nothing more. Deliberately coarse: Task 5's
// friendship_settings only has a boolean send_live_nudges gate, enforced server-side by RLS
// (supabase/migrations/20260815000002_v2_rls_policies.sql's "group members can read visible
// friend session events" policy) - the richer per-field visibility toggles described in
// docs/Draft1_Architecture_Overview.md's "Friend accountability" list (goal text, time
// remaining, current domain, number of interventions, full history) are Task 10's scope, not
// built yet. This panel does not invent any visibility control beyond what the query already
// enforces - same gap Task 5's RLS migration comments already flagged for Task 10 to fill.
//
// "Who" is shown as a raw user id: friendGroupApi.ts's listMembers() has the identical
// limitation (no `profiles` table exists yet to resolve a display name - see its own comment),
// so there is no display-name source anywhere in this codebase yet for this panel to use.
//
// v2 Task 7 additions: a nudge-send picker (target friend + predefined message catalog, gated
// server-side per nudges' RLS - see supabase/migrations/20260815000007_v2_nudges.sql) and
// incoming-nudge rendering (IncomingNudgeCard above). Both follow this panel's existing
// message-passing-only convention (sendMessage, no direct infrastructure/backend imports beyond
// types - matches the FriendEvent type import already present here).
export function FriendGroupPanel({ onClose }: FriendGroupPanelProps) {
  const [events, setEvents] = useState<FriendEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [selectedFriendId, setSelectedFriendId] = useState("");

  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  const [incomingNudges, setIncomingNudges] = useState<FriendNudge[] | null>(null);
  const [nudgesError, setNudgesError] = useState<string | null>(null);
  const [dismissedNudgeIds, setDismissedNudgeIds] = useState<Set<string>>(new Set());

  function loadEvents() {
    setLoading(true);
    setError(null);
    sendMessage<{ ok: boolean; events?: FriendEvent[]; error?: string }>({
      type: "FRIEND_EVENTS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok || !res.events) {
          setError(res.error ?? "Could not load friend activity.");
          return;
        }
        setEvents(res.events);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated.
        console.error("Failed to fetch friend events", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  function loadNudges() {
    setNudgesError(null);
    sendMessage<{ ok: boolean; nudges?: FriendNudge[]; error?: string }>({
      type: "NUDGES_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok) {
          setNudgesError(res.error ?? "Could not load incoming nudges.");
          return;
        }
        setIncomingNudges(res.nudges ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch incoming nudges", err);
        setNudgesError(err instanceof Error ? err.message : String(err));
      });
  }

  // Discovers who this panel's "send a nudge" picker can target: every distinct member (minus
  // the current user) across every group the current user belongs to. There is no "list my
  // groups" fetch anywhere else in this codebase yet (AccountPage.tsx only ever remembers the
  // single group it just created/joined, in local component state - see friendGroupApi.ts's
  // listMyGroups() comment), so this is the first caller of that new function/message.
  function loadFriends() {
    setFriendsLoading(true);
    setFriendsError(null);
    sendMessage<{ ok: boolean; session?: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((sessionRes) => {
        if (!sessionRes.ok) {
          setFriendsError(sessionRes.error ?? "Could not verify your sign-in status.");
          return undefined;
        }
        const userId = sessionRes.session?.user.id ?? null;
        setSelfUserId(userId);
        if (!userId) {
          setFriendIds([]);
          return undefined;
        }

        return sendMessage<{ ok: boolean; memberships?: GroupMembership[]; error?: string }>({
          type: "GROUP_LIST_MINE",
        }).then((groupsRes) => {
          if (!groupsRes.ok) {
            setFriendsError(groupsRes.error ?? "Could not load your groups.");
            return undefined;
          }
          const memberships = groupsRes.memberships ?? [];
          if (memberships.length === 0) {
            setFriendIds([]);
            return undefined;
          }

          return Promise.all(
            memberships.map((m) =>
              sendMessage<{ ok: boolean; members?: GroupMembership[]; error?: string }>({
                type: "GROUP_LIST_MEMBERS",
                payload: { groupId: m.groupId },
              })
            )
          ).then((memberResponses) => {
            const ids = new Set<string>();
            for (const res of memberResponses) {
              if (!res.ok || !res.members) continue;
              for (const member of res.members) {
                if (member.userId !== userId) ids.add(member.userId);
              }
            }
            setFriendIds([...ids]);
          });
        });
      })
      .catch((err) => {
        console.error("Failed to load friends to nudge", err);
        setFriendsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setFriendsLoading(false));
  }

  useEffect(() => {
    loadEvents();
    loadFriends();
    loadNudges();
  }, []);

  // The friend the picker targets: whatever the user explicitly picked, defaulting to the first
  // loaded friend otherwise - so a user with exactly one friend (the common case early on)
  // doesn't have to interact with the select at all before sending. Computed inline during
  // render rather than synced into state via a second useEffect (an earlier version did that,
  // and had a real bug: the effect that called setSelectedFriendId only fires on the render
  // *after* friendIds first becomes non-empty, so the message buttons could render already
  // enabled-looking but still be disabled/no-op for one extra render pass). This derivation is
  // synchronous with the same render that first shows the buttons, so there's no such gap.
  const effectiveFriendId = selectedFriendId || friendIds?.[0] || "";

  function handleSendNudge(friendId: string, messageId: string) {
    if (!friendId) return;
    setSendBusy(true);
    setSendError(null);
    setSendSuccess(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "NUDGE_SEND",
      payload: { friendUserId: friendId, messageId },
    })
      .then((res) => {
        if (!res.ok) {
          // Server-side rejection (toggle off or cooldown active - see
          // supabase/migrations/20260815000007_v2_nudges.sql's can_send_nudge()) - surfaced
          // inline, never silently swallowed.
          setSendError(res.error ?? "Could not send that nudge.");
          return;
        }
        setSendSuccess("Nudge sent.");
      })
      .catch((err) => {
        console.error("Failed to send nudge", err);
        setSendError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSendBusy(false));
  }

  function dismissNudge(nudgeId: string) {
    setDismissedNudgeIds((prev) => new Set(prev).add(nudgeId));
  }

  const visibleNudge = incomingNudges?.find((n) => !dismissedNudgeIds.has(n.id)) ?? null;

  return (
    <div className="friend-group-panel">
      <header className="friend-group-panel__header">
        <h2>Friend activity</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {visibleNudge && (
        <IncomingNudgeCard nudge={visibleNudge} onDismiss={() => dismissNudge(visibleNudge.id)} />
      )}
      {nudgesError && (
        <p role="alert">Couldn't load incoming nudges: {nudgesError}. Please try again.</p>
      )}

      <section className="friend-group-panel__nudge-send">
        <h3>Send a nudge</h3>
        {friendsLoading && !friendIds && <p>Loading friends…</p>}
        {friendsError && (
          <p role="alert">Couldn't load friends: {friendsError}. Please try again.</p>
        )}
        {friendIds && friendIds.length === 0 && !friendsError && (
          <p>No friends to nudge yet — join a group first.</p>
        )}
        {friendIds && friendIds.length > 0 && (
          <>
            <label>
              Friend
              <select
                value={effectiveFriendId}
                onChange={(e) => setSelectedFriendId(e.target.value)}
              >
                {friendIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <div className="friend-group-panel__nudge-messages">
              {NUDGE_MESSAGES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleSendNudge(effectiveFriendId, m.id)}
                  disabled={sendBusy || !effectiveFriendId}
                >
                  {m.text}
                </button>
              ))}
            </div>
            {sendError && <p role="alert">Nudge not sent: {sendError}</p>}
            {sendSuccess && <p>{sendSuccess}</p>}
          </>
        )}
      </section>

      <button
        type="button"
        onClick={() => {
          // Fix round 1: Refresh previously only re-triggered FRIEND_EVENTS_FETCH, so a user
          // manually refreshing wouldn't pick up new nudges without closing/reopening the panel
          // - both fetches now run together, matching what "Refresh" implies.
          loadEvents();
          loadNudges();
        }}
        disabled={loading}
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>

      {error && <p role="alert">Couldn't load friend activity: {error}. Please try again.</p>}

      {events && events.length === 0 && !error && <p>No recent friend activity.</p>}

      {events && events.length > 0 && (
        <ul className="friend-group-panel__events">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.displayLabel}</strong> — friend {event.userId} —{" "}
              {new Date(event.occurredAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
