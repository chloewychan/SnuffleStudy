import { useEffect, useRef, useState } from "react";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import type { StudyRoom, RoomParticipant } from "../../domain/rooms/studyRoom";

// v2 Task 13: Study Rooms.
//
// Calls studyRoomApi.ts and videoCallClient.ts DIRECTLY (not via sendMessage/messageRouter.ts,
// unlike every other sidepanel panel component in this codebase - FriendGroupPanel.tsx/
// UnlockRequestPanel.tsx/TempPasscodePanel.tsx all route through the background service worker).
// See studyRoomApi.ts's own header comment for the full rationale; summarized here: presence's
// live-callback shape and videoCallClient's hard DOM/camera/mic requirement (a service worker has
// no getUserMedia) both need this component to hold a persistent, direct connection to Supabase
// Realtime and to LiveKit for as long as it's mounted - a message-passing round trip through the
// background doesn't fit either requirement, and inventing a new port-forwarding protocol to
// force-fit it would serve only this one feature.

interface StudyRoomPanelProps {
  onClose: () => void;
}

// Local, UI-only view of "who's currently in the joined room" - keyed by userId so a presence
// UPDATE (e.g. a rejoin) replaces rather than duplicates an existing entry, and a DELETE/left_at
// transition removes it. Realtime's own event ordering is not guaranteed to be gap-free across a
// reconnect, but this is a best-effort live view, not the source of truth (studyRoomApi.ts's RLS-
// gated queries always remain the source of truth for anything security-relevant).
function applyPresenceEvent(
  current: Map<string, RoomParticipant>,
  event: { eventType: "INSERT" | "UPDATE" | "DELETE"; participant: RoomParticipant }
): Map<string, RoomParticipant> {
  const next = new Map(current);
  const { participant } = event;
  if (event.eventType === "DELETE" || participant.leftAt !== null) {
    next.delete(participant.userId);
  } else {
    next.set(participant.userId, participant);
  }
  return next;
}

export function StudyRoomPanel({ onClose }: StudyRoomPanelProps) {
  const [rooms, setRooms] = useState<StudyRoom[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newRoomName, setNewRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinedRoom, setJoinedRoom] = useState<StudyRoom | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const [participants, setParticipants] = useState<Map<string, RoomParticipant>>(new Map());

  // Where LiveKit's own attach()'d <video>/<audio> elements get appended - see
  // videoCallClient.ts's VideoCallEvent union. Keyed by participant identity so a track-removed
  // event can find and detach exactly the right element without touching anyone else's tile.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const unsubscribePresenceRef = useRef<(() => void) | null>(null);

  function loadRooms() {
    setLoadError(null);
    studyRoomApi
      .listRooms()
      .then(setRooms)
      .catch((err) => {
        console.error("Failed to load study rooms", err);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }

  useEffect(() => {
    loadRooms();
  }, []);

  // Video event wiring - registered once for the component's lifetime (videoCallClient is a
  // singleton with at most one active call, so there's nothing to re-subscribe per room).
  useEffect(() => {
    const unsubscribe = videoCallClient.onVideoCallEvent((event) => {
      if (event.type === "track-added") {
        let tile = tileRefs.current.get(event.participantIdentity);
        if (!tile) {
          tile = document.createElement("div");
          tile.className = "study-room-panel__tile";
          tile.dataset.participant = event.participantIdentity;
          const label = document.createElement("span");
          label.className = "study-room-panel__tile-label";
          label.textContent = event.isLocal ? "You" : event.participantIdentity;
          tile.appendChild(label);
          tileRefs.current.set(event.participantIdentity, tile);
          gridRef.current?.appendChild(tile);
        }
        event.element.classList.add("study-room-panel__media");
        // Local video is muted client-side to avoid echoing the user's own mic back at them -
        // LiveKit's own audio track publishing to the room is unaffected by this element-level
        // mute, which only controls local HTMLMediaElement playback.
        if (event.isLocal && event.element instanceof HTMLVideoElement) {
          event.element.muted = true;
        }
        tile.appendChild(event.element);
      } else if (event.type === "track-removed") {
        event.element.remove();
      } else if (event.type === "participant-disconnected") {
        const tile = tileRefs.current.get(event.participantIdentity);
        tile?.remove();
        tileRefs.current.delete(event.participantIdentity);
      } else if (event.type === "disconnected") {
        for (const tile of tileRefs.current.values()) {
          tile.remove();
        }
        tileRefs.current.clear();
      }
    });
    return unsubscribe;
  }, []);

  // Cleanup on unmount - if the panel is closed/navigated away from while still in a call, leave
  // cleanly rather than leaking an open LiveKit connection and a stale Realtime subscription.
  useEffect(() => {
    return () => {
      unsubscribePresenceRef.current?.();
      videoCallClient.leaveCall();
    };
  }, []);

  function handleCreateRoom() {
    const trimmed = newRoomName.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateError(null);
    studyRoomApi
      .createRoom(trimmed)
      .then((room) => {
        setNewRoomName("");
        setRooms((prev) => [room, ...(prev ?? [])]);
      })
      .catch((err) => {
        console.error("Failed to create study room", err);
        setCreateError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setCreating(false));
  }

  async function handleJoinRoom(room: StudyRoom) {
    setJoining(room.id);
    setJoinError(null);
    try {
      const { token } = await studyRoomApi.joinRoom(room.id);
      await videoCallClient.joinCall(room.id, token);

      const initialParticipants = await studyRoomApi.listParticipants(room.id);
      setParticipants(new Map(initialParticipants.map((p) => [p.userId, p])));

      unsubscribePresenceRef.current = studyRoomApi.subscribeToPresence(room.id, (event) => {
        setParticipants((prev) => applyPresenceEvent(prev, event));
      });

      setJoinedRoom(room);
    } catch (err) {
      console.error("Failed to join study room", err);
      setJoinError(err instanceof Error ? err.message : String(err));
      // Best-effort unwind - a partial join (e.g. the participant row was inserted but the video
      // token or LiveKit connect failed) shouldn't leave the local call state stuck "joined".
      videoCallClient.leaveCall();
    } finally {
      setJoining(null);
    }
  }

  async function handleLeaveRoom() {
    if (!joinedRoom) return;
    setLeaving(true);
    try {
      unsubscribePresenceRef.current?.();
      unsubscribePresenceRef.current = null;
      videoCallClient.leaveCall();
      await studyRoomApi.leaveRoom(joinedRoom.id);
    } catch (err) {
      // Local call/presence teardown above already ran regardless - a failure here only means
      // the server-side left_at write didn't land (e.g. offline), not that the user is still
      // visibly "in" the room from their own client's perspective.
      console.error("Failed to record leaving the study room", err);
    } finally {
      setJoinedRoom(null);
      setParticipants(new Map());
      setLeaving(false);
    }
  }

  if (joinedRoom) {
    return (
      <div className="study-room-panel">
        <header className="study-room-panel__header">
          <h2>{joinedRoom.name}</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div ref={gridRef} className="study-room-panel__grid" />

        <section className="study-room-panel__presence">
          <h3>In this room ({participants.size})</h3>
          <ul>
            {[...participants.values()].map((p) => (
              <li key={p.userId}>{p.userId}</li>
            ))}
          </ul>
        </section>

        {joinError && <p role="alert">{joinError}</p>}

        <button type="button" onClick={handleLeaveRoom} disabled={leaving}>
          {leaving ? "Leaving…" : "Leave room"}
        </button>
      </div>
    );
  }

  return (
    <div className="study-room-panel">
      <header className="study-room-panel__header">
        <h2>Study Rooms</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="study-room-panel__create">
        <label>
          New room name
          <input
            type="text"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            placeholder="e.g. Thursday study group"
            disabled={creating}
          />
        </label>
        <button type="button" onClick={handleCreateRoom} disabled={creating || !newRoomName.trim()}>
          {creating ? "Creating…" : "Create room"}
        </button>
        {createError && <p role="alert">Could not create room: {createError}</p>}
      </section>

      <section className="study-room-panel__list">
        <h3>Rooms in your groups</h3>
        {loadError && <p role="alert">Could not load rooms: {loadError}</p>}
        {rooms === null && !loadError && <p>Loading…</p>}
        {rooms !== null && rooms.length === 0 && <p>No study rooms yet — create one to get started.</p>}
        {rooms !== null && rooms.length > 0 && (
          <ul>
            {rooms.map((room) => (
              <li key={room.id}>
                <span>{room.name}</span>
                <button
                  type="button"
                  onClick={() => handleJoinRoom(room)}
                  disabled={joining === room.id}
                >
                  {joining === room.id ? "Joining…" : "Join"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {joinError && <p role="alert">{joinError}</p>}
      </section>

      <button type="button" onClick={loadRooms}>
        Refresh
      </button>
    </div>
  );
}
