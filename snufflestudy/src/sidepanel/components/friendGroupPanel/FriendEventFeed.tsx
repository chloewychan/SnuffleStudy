import type { FriendEvent } from "../../../infrastructure/backend/sessionStatusSyncApi";

interface FriendEventFeedProps {
  events: FriendEvent[] | null;
  error: string | null;
  loading: boolean;
  // Refreshes events, incoming nudges, the digest, and producer tags together - see
  // FriendGroupPanel's own handleRefresh comment for why loadFriends is deliberately excluded.
  onRefresh: () => void;
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
export function FriendEventFeed({ events, error, loading, onRefresh }: FriendEventFeedProps) {
  return (
    <>
      <button type="button" onClick={onRefresh} disabled={loading}>
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
    </>
  );
}
