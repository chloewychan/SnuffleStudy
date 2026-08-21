// v2 Task 13: Study Rooms.
//
// Judgment call (documented per this task's brief, which explicitly flags this as a fork point):
// unlockRequestApi.ts/nudgeApi.ts/digestApi.ts (Tasks 6-9) all define their task-owned backend
// types directly inside their *Api.ts file rather than a separate domain/ module, and that wasn't
// flagged as a problem anywhere in this codebase's history. This task's plan entry, however,
// explicitly names `domain/rooms/studyRoom.ts` as its own file in the Deliverables list ("backing
// study_rooms / study_room_participants tables (schema addition to Task 5's migrations)") -
// unlike Task 6-9's entries, which only ever named an *Api.ts file. Since the plan is explicit
// about this one path, this file exists and is used, rather than following the more common
// in-*Api.ts precedent - kept internally consistent by having studyRoomApi.ts import these types
// rather than redeclaring its own copies.
//
// Camel-cased, mirroring every other *Api.ts row-mapping convention in this codebase (e.g.
// friendGroupApi.ts's FriendGroup/InviteCode/GroupMembership) even though the underlying Postgres
// columns are snake_case (see supabase/migrations/20260815000001_v2_accountability_schema.sql).

export interface StudyRoom {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
}

// study_room_participants' actual primary key is the composite (room_id, user_id, joined_at) -
// repeated join/leave cycles produce multiple historical rows for the same (roomId, userId) pair,
// each with its own joinedAt. leftAt is null exactly while that specific join is still "current".
export interface RoomParticipant {
  roomId: string;
  userId: string;
  joinedAt: string;
  leftAt: string | null;
}

// The shape studyRoomApi.ts's subscribeToPresence(...) hands back on every Postgres Changes event
// for study_room_participants. Deliberately a plain, small, table-shaped payload rather than
// anything Supabase-Realtime-specific (no RealtimePostgresChangesPayload type leaks out of
// studyRoomApi.ts) - callers (StudyRoomPanel.tsx) only ever need to know which participant row
// changed and how.
export interface PresenceChangeEvent {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  participant: RoomParticipant;
}
