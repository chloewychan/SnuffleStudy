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

// A row in study_room_invitees - one explicit grant of future-visibility/join access to
// `userId` for `roomId`, given by the room's owner (`invitedBy`, always the owner - the only
// INSERT path is an "owner can manage invitees" RLS policy on this table).
export interface RoomInvitee {
  roomId: string;
  userId: string;
  invitedBy: string;
  invitedAt: string;
}
