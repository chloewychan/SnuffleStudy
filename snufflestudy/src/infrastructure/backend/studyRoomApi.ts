import { supabase } from "./supabaseClient";
import type { StudyRoom, RoomParticipant, PresenceChangeEvent } from "../../domain/rooms/studyRoom";

// v2 Task 13: Study Rooms.
//
// Architectural fork point, documented per this task's brief (which flags this as a genuine
// choice no prior task needed to make): every prior *Api.ts file in this directory (Tasks 5-12)
// is called ONLY from src/background/messageRouter.ts - UI components talk to it exclusively via
// sendMessage(), never importing infrastructure/backend/* directly (see FriendGroupPanel.tsx's/
// UnlockRequestPanel.tsx's own header comments: "message-passing-only convention"). This file
// deliberately breaks that convention and is called DIRECTLY from
// sidepanel/components/StudyRoomPanel.tsx instead. Two independent reasons, either one alone
// would be sufficient:
//
// 1. subscribeToPresence's live-callback shape has no fit in this codebase's existing
//    message-passing surface. Every previous backend integration is either a one-shot
//    request/response (sendMessage resolves once) or a background-alarm-driven poll
//    (alarmHandlers.ts calling a *Api.ts poll function on a timer, then pushing a
//    chrome.notifications toast - never streaming live events back into an open UI). Supabase
//    Realtime's channel().on(...).subscribe() model needs to keep invoking a callback for as
//    long as the UI is mounted and interested - piping that through chrome.runtime.sendMessage
//    would require inventing a new bidirectional port protocol (a persistent connection plus
//    event-forwarding plumbing in messageRouter.ts) that nothing else in this codebase has, to
//    serve exactly one feature. Calling supabase.channel(...) directly from the sidepanel (a real,
//    persistently-open DOM page for as long as the panel is visible - not the background service
//    worker, which Realtime's WebSocket could run from too, but which has no way to push a live
//    callback into a UI component without that same missing port protocol) is the direct, minimal
//    path.
// 2. infrastructure/video/videoCallClient.ts MUST run in the sidepanel's real DOM context (camera/
//    mic access, WebRTC) - that's not a choice, it's a browser/MV3 constraint (a service worker
//    has no getUserMedia). Since joinRoom()'s LiveKit token has to flow directly into
//    videoCallClient.joinCall(roomId, token) with no indirection, keeping studyRoomApi.ts's DB
//    operations in that same direct-call context avoids a second round trip and keeps the whole
//    join flow (insert participant row -> mint token -> connect to LiveKit) in one place instead
//    of splitting it across a background message hop and a direct sidepanel call.
//
// The sidepanel already has legitimate access to the same `supabase` singleton
// (infrastructure/backend/supabaseClient.ts) that messageRouter.ts uses - nothing about that
// module is background-only (its own header comment explains the chrome.storage.local auth
// adapter is there because the *background* happened to be where earlier tasks' sync logic lived,
// not because sidepanel access is unsafe or unsupported). The original "sendMessage only" pattern
// documented in Tasks 5-12 was about keeping ONE consistent calling convention across those
// features (all one-shot request/response), not a hard technical wall - it doesn't fit this
// feature's live-subscription and real-DOM-media requirements, so it isn't followed here.

interface StudyRoomRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

interface RoomParticipantRow {
  room_id: string;
  user_id: string;
  joined_at: string;
  left_at: string | null;
}

function toStudyRoom(row: StudyRoomRow): StudyRoom {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
  };
}

function toRoomParticipant(row: RoomParticipantRow): RoomParticipant {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
  };
}

// Mirrors friendGroupApi.ts's/tempPasscodeApi.ts's requireUserId()+throw convention - createRoom/
// joinRoom/leaveRoom are all explicit, infrequent user-initiated button presses, not hot-path
// lifecycle transitions, so paying getUser()'s extra round trip for a verified identity is fine
// here (same rationale tempPasscodeApi.ts's own copy of this comment gives).
async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Inserts a study_rooms row owned by the current user. No pre-generated client-side id needed
// (contrast friendGroupApi.ts's createGroup(), which has to generate one up front to dodge a
// chicken-and-egg RLS gap on friend_groups) - study_rooms' SELECT policy already includes a plain
// `owner_user_id = auth.uid()` clause (supabase/migrations/20260815000002_v2_rls_policies.sql,
// unchanged by this task's migration), so `.insert(...).select().single()`'s own RETURNING read
// is satisfied immediately by the just-inserted row, with no second row needed to exist first.
export async function createRoom(name: string): Promise<StudyRoom> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from("study_rooms")
    .insert({ name, owner_user_id: userId })
    .select()
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create study room.");
  }

  return toStudyRoom(data as StudyRoomRow);
}

// Rooms visible to the current user under study_rooms' own RLS SELECT policy (supabase/
// migrations/20260815000019_v2_study_rooms_group_visibility_and_join_gate.sql): rooms they own,
// rooms owned by anyone they share a group with, and rooms they're already a participant of. No
// client-side re-filtering by group membership here (e.g. re-deriving via friendGroupApi.ts's
// listMyGroups + a manual owner_user_id-in-that-set filter) - this codebase's own constraint is
// visibility "enforced with Postgres Row Level Security, not just client-side filtering"
// (docs/V2_Implementation_Plan.md's Global Constraints), so this trusts whatever RLS returns
// exactly like tempPasscodeApi.ts's queryRelevantSince already does for its own table.
export async function listRooms(): Promise<StudyRoom[]> {
  await requireUserId();

  const { data, error } = await supabase
    .from("study_rooms")
    .select()
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => toStudyRoom(row as StudyRoomRow));
}

// Joins a room: inserts the caller's own study_room_participants row (gated by that table's own
// INSERT policy - the caller must be the room's owner or share a group with the owner, per
// migration 20260815000019), then mints a LiveKit access token scoped to this room and the
// caller's own identity via the generate-livekit-token Edge Function.
//
// Return type is NOT literally what the plan's Interfaces line documents (it only writes
// `joinRoom(roomId)` with no explicit return type) - but the caller (StudyRoomPanel.tsx) needs a
// LiveKit token to actually join the video call, and generating that token is exactly what
// generate-livekit-token exists for, so returning it here (rather than a second, separate call)
// is the natural single round trip. Documented here as the deliberate interpretation, same as
// tempPasscodeApi.ts's own joinRoom-shaped precedent (approveRequest returning `{ code }`).
//
// Unlike tempPasscodeApi.ts's fire-and-forget email leg, both steps here are awaited and either
// can fail the whole call - there is no useful "partial join" (a participant row with no video
// token is a dead end the UI can't do anything with), so this does not follow this codebase's
// graceful-degradation convention the way e.g. redeemCode does; it throws on either failure.
export async function joinRoom(roomId: string): Promise<{ token: string }> {
  const userId = await requireUserId();

  const { error: insertError } = await supabase
    .from("study_room_participants")
    .insert({ room_id: roomId, user_id: userId });
  if (insertError) {
    throw new Error(
      insertError.message ??
        "Could not join this room — you may not share a group with its owner."
    );
  }

  const { data, error: tokenError } = await supabase.functions.invoke<{
    token?: string;
    error?: string;
  }>("generate-livekit-token", { body: { roomId } });
  if (tokenError || !data?.token) {
    throw new Error(data?.error ?? tokenError?.message ?? "Failed to obtain a video call token.");
  }

  return { token: data.token };
}

// Sets left_at on the caller's currently-open participant row for this room. study_room_participants'
// primary key is the composite (room_id, user_id, joined_at) - repeated join/leave cycles leave
// multiple historical rows for the same (roomId, userId) pair, so this updates whichever one(s)
// currently have left_at is null for this room/user (normally exactly one - the row joinRoom()
// most recently inserted). Authorized by study_room_participants' "users can update their own
// participant row" policy (user_id = auth.uid(), unchanged by this task's migration).
export async function leaveRoom(roomId: string): Promise<void> {
  const userId = await requireUserId();

  const { error } = await supabase
    .from("study_room_participants")
    .update({ left_at: new Date().toISOString() })
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .is("left_at", null);
  if (error) {
    throw new Error(error.message);
  }
}

// Currently-open participant rows (left_at is null) for a room - not named in the plan's literal
// Interfaces list (createRoom/joinRoom/leaveRoom/subscribeToPresence only), but a real presence UI
// needs an initial snapshot to render before the first live change event arrives - Supabase
// Realtime's Postgres Changes stream only ever delivers CHANGES from the moment of subscription
// onward, never a backfill of current state. Same "additive beyond the plan's literal function
// list, because the real UI needs it" precedent as friendGroupApi.ts's listMyGroups (Task 7).
// Only ever meaningfully callable after joinRoom() (or by the room's owner) - study_room_participants'
// own SELECT policy (unchanged by this task's migration) requires the caller to already have a
// qualifying row for this room.
export async function listParticipants(roomId: string): Promise<RoomParticipant[]> {
  const { data, error } = await supabase
    .from("study_room_participants")
    .select()
    .eq("room_id", roomId)
    .is("left_at", null);
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => toRoomParticipant(row as RoomParticipantRow));
}

// Presence via Supabase Realtime's Postgres Changes - the first use of Realtime anywhere in this
// codebase (see migration 20260815000019's header comment for why no additional RLS widening was
// needed to authorize this: Postgres Changes events are gated by the subscriber's own SELECT
// policy on the table, and a caller only ever calls this after joinRoom() has already given them
// a qualifying participant row for this room).
//
// Returns an unsubscribe function, per the plan's own signature
// (`subscribeToPresence(roomId, onChange): () => void`). supabase.removeChannel(...) (rather than
// just channel.unsubscribe()) is used for cleanup - it's the documented way to fully tear down a
// channel's WebSocket-level subscription and free it from the client's internal channel registry,
// not just stop delivering events to this particular callback.
export function subscribeToPresence(
  roomId: string,
  onChange: (event: PresenceChangeEvent) => void
): () => void {
  const channel = supabase
    .channel(`study-room-presence-${roomId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "study_room_participants", filter: `room_id=eq.${roomId}` },
      (payload) => {
        const row = (
          payload.eventType === "DELETE" ? payload.old : payload.new
        ) as RoomParticipantRow;
        onChange({
          eventType: payload.eventType,
          participant: toRoomParticipant(row),
        });
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
