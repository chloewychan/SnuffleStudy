import { supabase } from "./supabaseClient";
import type { SessionEventType } from "../../domain/session/sessionTypes";

// The minimal event shape a friend is allowed to see, per the architecture overview's privacy
// example - only the columns session_status_events itself exposes (see
// supabase/migrations/20260815000001_v2_accountability_schema.sql), camelCased to match this
// codebase's TS conventions (see friendGroupApi.ts's identical row->interface mapping style).
// Nothing beyond what the table returns is invented here - richer per-field visibility (goal
// text, time remaining, current domain, etc. from docs/Draft1_Architecture_Overview.md's
// "Friend accountability" list) is Task 10's scope, not built yet.
export interface FriendEvent {
  id: string;
  userId: string;
  sessionId: string;
  type: SessionEventType;
  displayLabel: string;
  occurredAt: number;
}

interface SessionStatusEventRow {
  id: string;
  user_id: string;
  session_id: string;
  type: string;
  display_label: string;
  occurred_at: string;
}

// Reads the current auth session via supabase.auth.getSession() rather than .getUser()
// (contrast friendGroupApi.ts's requireUserId(), which uses .getUser() for its explicit,
// infrequent user-initiated actions). getSession() reads the already-persisted/cached session
// through chromeStorageAuthAdapter without a dedicated round-trip to Supabase's Auth server in
// the common case (unlike .getUser(), which always makes one) - deliberate here because both
// functions below are called from v1's session lifecycle hot path (messageRouter.ts /
// alarmHandlers.ts, on every start/pause/resume/break/end/complete), where the Task 6 brief
// requires a signed-out user to pay "zero network cost" rather than merely catching a resulting
// error. Returns null (never throws) so callers can treat "not signed in" as a plain no-op.
async function currentUserId(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) return null;
    return data.session.user.id;
  } catch (err) {
    console.error("Failed to read Supabase auth session", err);
    return null;
  }
}

function toFriendEvent(row: SessionStatusEventRow): FriendEvent {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    type: row.type as SessionEventType,
    displayLabel: row.display_label,
    occurredAt: new Date(row.occurred_at).getTime(),
  };
}

// Inserts a session_status_events row for the current user. Never throws - v2's offline-first
// constraint ("a friend group feature failing to sync should never block starting or running a
// local session") means every call site in messageRouter.ts/alarmHandlers.ts treats this as
// fire-and-forget best-effort, but this function is defensive on its own terms too rather than
// relying purely on callers to catch it correctly.
export async function recordStatusEvent(event: {
  type: SessionEventType;
  sessionId: string;
  displayLabel: string;
}): Promise<void> {
  try {
    const userId = await currentUserId();
    if (!userId) return; // Not signed in - sync is entirely opt-in/best-effort.

    const { error } = await supabase.from("session_status_events").insert({
      user_id: userId,
      session_id: event.sessionId,
      type: event.type,
      display_label: event.displayLabel,
      occurred_at: new Date().toISOString(),
    });
    if (error) {
      console.error("Failed to record session status event", error);
    }
  } catch (err) {
    console.error("Failed to record session status event", err);
  }
}

// Fetches session_status_events rows newer than sinceTimestamp. Deliberately unfiltered beyond
// the timestamp bound - server-side RLS (supabase/migrations/20260815000002_v2_rls_policies.sql,
// "own session events always readable" + "group members can read visible friend session
// events") already restricts the result to the caller's own rows plus rows from group-mates who
// have send_live_nudges = true toward the caller, so the client trusts whatever comes back
// rather than re-deriving that visibility logic here.
export async function fetchNewEventsForFriends(sinceTimestamp: number): Promise<FriendEvent[]> {
  try {
    const userId = await currentUserId();
    if (!userId) return []; // Not signed in - nothing to fetch, no-op rather than an error.

    const { data, error } = await supabase
      .from("session_status_events")
      .select()
      .gt("occurred_at", new Date(sinceTimestamp).toISOString())
      .order("occurred_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch friend session events", error);
      return [];
    }
    return (data as SessionStatusEventRow[]).map(toFriendEvent);
  } catch (err) {
    console.error("Failed to fetch friend session events", err);
    return [];
  }
}
