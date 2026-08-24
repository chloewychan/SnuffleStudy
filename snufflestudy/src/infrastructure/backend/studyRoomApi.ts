import { supabase } from "./supabaseClient";
import type { StudyRoom, RoomParticipant, PresenceChangeEvent } from "../../domain/rooms/studyRoom";

// v2 Task 13: Study Rooms.
//
// createRoom/listRooms/leaveRoom/listParticipants are called from src/background/messageRouter.ts
// via sendMessage() (STUDY_ROOM_CREATE/STUDY_ROOM_LIST/STUDY_ROOM_LEAVE/
// STUDY_ROOM_LIST_PARTICIPANTS - see src/shared/messages.ts), following this codebase's normal
// convention exactly (FriendGroupPanel.tsx's/UnlockRequestPanel.tsx's "message-passing-only"
// pattern) - these are plain one-shot DB reads/writes with no live-callback or DOM/media coupling,
// structurally identical to every prior *Api.ts call this codebase already routes that way.
//
// Fix round 1 (Important, code review): an earlier version of this file routed ALL SIX exports,
// including these four, directly from sidepanel/components/StudyRoomPanel.tsx, justified by
// joinRoom/subscribeToPresence's genuine DOM/live-callback requirements below. That justification
// does not extend to createRoom/listRooms/leaveRoom/listParticipants - review correctly flagged
// this as broader than its own reasoning supported (it made this the first UI component in the
// codebase to bypass message-passing at all, set a precedent other panels could point to, and
// duplicated error-handling messageRouter.handleMessage already centralizes once). Narrowed here
// to exactly the two functions that actually need it:
//
// joinRoom and subscribeToPresence remain called DIRECTLY from StudyRoomPanel.tsx - not proxied
// through messageRouter.ts. Two independent, narrower reasons:
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
// 2. joinRoom's LiveKit token has to flow directly into
//    infrastructure/video/videoCallClient.ts's joinCall(roomId, token) with no indirection -
//    videoCallClient.ts MUST run in the sidepanel's real DOM context (camera/mic access, WebRTC),
//    which is a browser/MV3 constraint (a service worker has no getUserMedia), not a choice.
//    Keeping joinRoom's participant-row insert and its generate-livekit-token call as one direct
//    client-side round trip (rather than splitting the insert through messageRouter.ts and the
//    token mint direct) avoids an extra hop for a flow that immediately hands its result to
//    videoCallClient.joinCall anyway.
//
// The sidepanel already has legitimate access to the same `supabase` singleton
// (infrastructure/backend/supabaseClient.ts) that messageRouter.ts uses for these two - nothing
// about that module is background-only.

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
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => toStudyRoom(row as StudyRoomRow));
}

// v3.3 Task 6: soft delete. Sets archived_at on a room the caller owns rather than a real DELETE -
// producer_tag_sends.recipient_room_id references study_rooms(id) with no ON DELETE CASCADE
// anywhere in this schema, so a hard delete risks either an FK violation or silently erasing real
// Producer Tag history unrelated to this decision. Both .eq() clauses matter: owner_user_id is
// belt-and-suspenders alongside supabase/migrations/20260815000033_v3.3_archive_study_rooms.sql's
// "owner can archive their own room" UPDATE policy (using (owner_user_id = auth.uid())) - RLS
// already denies a non-owner's attempt (the using clause matches zero rows), but scoping the query
// the same way createRoom/leaveRoom already do keeps this file's own intent legible without
// relying on the reader to know the policy exists. Throws on a Postgres error, same convention as
// createRoom/leaveRoom.
export async function archiveRoom(roomId: string): Promise<void> {
  const userId = await requireUserId();

  const { error } = await supabase
    .from("study_rooms")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", roomId)
    .eq("owner_user_id", userId);
  if (error) {
    throw new Error(error.message);
  }
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
