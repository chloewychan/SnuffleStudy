import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { FriendEvent } from "../../infrastructure/backend/sessionStatusSyncApi";

interface FriendGroupPanelProps {
  onClose: () => void;
}

// Default lookback window for this panel's fetch/refresh - a point-in-time view of recent
// activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll alarm,
// which tracks its own separate "last checked" cursor via friendPollState.ts for
// chrome.notifications toasts). 24h is a reasonable "what's been happening" window without
// needing its own persisted "last viewed" cursor.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
export function FriendGroupPanel({ onClose }: FriendGroupPanelProps) {
  const [events, setEvents] = useState<FriendEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  useEffect(() => {
    loadEvents();
  }, []);

  return (
    <div className="friend-group-panel">
      <header className="friend-group-panel__header">
        <h2>Friend activity</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      <button type="button" onClick={loadEvents} disabled={loading}>
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
