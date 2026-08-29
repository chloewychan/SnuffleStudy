import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import type { StudyRoom, RoomParticipant } from "../../domain/rooms/studyRoom";

// v4.1 Task 7: lifts the joined-room state StudyRoomPanel.tsx used to own locally (joinedRoom,
// participants, tiles, camera/mic, the LiveKit connection) into shared, app-shell-level state -
// mounted once in SidePanelApp.tsx (StudyRoomSessionProvider), so a joined call survives a tab
// switch instead of tearing down the moment its owning tab unmounts. StudyRoomsBox.tsx (the Study
// tab's list/create/manage-access box) and StudyRoomFooter.tsx (the persistent, joined-room view)
// both read/act through useStudyRoomSession() instead of owning any of this themselves.
//
// Every piece of state and every handler below is moved from StudyRoomPanel.tsx's
// joinedRoom/participants/tiles/cameraOn/micOn/mediaError/handleJoinRoom/handleLeaveRoom/
// handleToggleCamera/handleToggleMic/applyPresenceEvent/the video-event useEffect/the
// unmount-cleanup effect, with no behavior change beyond WHERE it lives - except that in-room
// producer-tag recording/broadcasting (roomTags, subscribeToRoomProducerTags, the
// handleSendProducerTagToRoom flow) is dropped entirely, not moved (scope doc: "Remove the ability
// to record a producer tag from inside the room" - Decision 9 leaves the room-broadcast backend in
// place, just unused after this version).
//
// New in this task: selectedParticipantIds (Set<string>), cleared on the same join/leave lifecycle
// as tiles/participants, plus toggleParticipantSelected/clearParticipantSelection - selecting a
// tile to nudge is a brand-new interaction (scope doc: "Make each tile selectable"), nothing to
// move from the old component for this part.
//
// Direct-call exceptions (unchanged from StudyRoomPanel.tsx's own documented rationale - see that
// file's header comment, preserved in this task's report rather than repeated verbatim here):
// studyRoomApi.joinRoom (the LiveKit token must flow straight into videoCallClient.joinCall, which
// needs this component's real DOM/media-permission context) and studyRoomApi.subscribeToPresence
// (a live Realtime callback with no fit in the one-shot sendMessage()/messageRouter.ts surface).
// videoCallClient.ts itself is always called directly - a pure client-side DOM/WebRTC wrapper, not
// a backend call.

export interface Tile {
  participantIdentity: string;
  isLocal: boolean;
  videoElement: HTMLVideoElement | null;
  audioElement: HTMLAudioElement | null;
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

interface StudyRoomSessionValue {
  joinedRoom: StudyRoom | null;
  joining: string | null;
  joinError: string | null;
  leaving: boolean;
  participants: Map<string, RoomParticipant>;
  tiles: Tile[];
  cameraOn: boolean;
  micOn: boolean;
  mediaError: { message: string; actionable: boolean } | null;
  selectedParticipantIds: Set<string>;
  joinRoom(room: StudyRoom, options: { camera: boolean; microphone: boolean }): Promise<void>;
  leaveRoom(): Promise<void>;
  toggleCamera(): void;
  toggleMic(): void;
  toggleParticipantSelected(userId: string): void;
  clearParticipantSelection(): void;
}

const StudyRoomSessionContext = createContext<StudyRoomSessionValue | null>(null);

export function StudyRoomSessionProvider({ children }: { children: ReactNode }) {
  const [joinedRoom, setJoinedRoom] = useState<StudyRoom | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const [participants, setParticipants] = useState<Map<string, RoomParticipant>>(new Map());
  const [tiles, setTiles] = useState<Tile[]>([]);

  // v3.3 Task 9 precedent, unchanged: one pair of flags does double duty - before joining they
  // drive the pre-join camera/mic checkboxes (StudyRoomsBox.tsx), read once by joinRoom() to build
  // joinCall's `initial` param; once joined, the SAME flags become the two in-room toggle buttons'
  // on/off label (StudyRoomFooter.tsx), updated optimistically on click.
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  const [mediaError, setMediaError] = useState<{ message: string; actionable: boolean } | null>(null);

  const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(new Set());

  const unsubscribePresenceRef = useRef<(() => void) | null>(null);

  function toggleCamera() {
    const next = !cameraOn;
    setCameraOn(next);
    videoCallClient.setCameraEnabled(next).catch((err) => {
      console.error("Failed to toggle camera", err);
    });
  }

  function toggleMic() {
    const next = !micOn;
    setMicOn(next);
    videoCallClient.setMicrophoneEnabled(next).catch((err) => {
      console.error("Failed to toggle microphone", err);
    });
  }

  function toggleParticipantSelected(userId: string) {
    setSelectedParticipantIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }

  function clearParticipantSelection() {
    setSelectedParticipantIds(new Set());
  }

  // Video event wiring - registered once for this provider's lifetime (videoCallClient is a
  // singleton with at most one active call, so there's nothing to re-subscribe per room). Updates
  // `tiles` state rather than touching the DOM directly - StudyRoomFooter.tsx's own
  // StudyRoomVideoTile is what actually inserts each tile's media elements, once React has
  // committed that tile's own container.
  useEffect(() => {
    const unsubscribe = videoCallClient.onVideoCallEvent((event) => {
      if (event.type === "track-added") {
        const isVideo = event.element instanceof HTMLVideoElement;
        event.element.classList.add("study-room-panel__media");
        // Local video is muted client-side to avoid echoing the user's own mic back at them -
        // LiveKit's own audio track publishing to the room is unaffected by this element-level
        // mute. The local preview is also mirrored (display-only, via a CSS transform) so it
        // behaves like a real mirror - it never touches the published track, so remote viewers
        // still see the true (unmirrored) orientation.
        if (event.isLocal && isVideo) {
          (event.element as HTMLVideoElement).muted = true;
          event.element.style.transform = "scaleX(-1)";
        }
        setTiles((prev) => {
          const idx = prev.findIndex((t) => t.participantIdentity === event.participantIdentity);
          if (idx === -1) {
            const tile: Tile = {
              participantIdentity: event.participantIdentity,
              isLocal: event.isLocal,
              videoElement: isVideo ? (event.element as HTMLVideoElement) : null,
              audioElement: isVideo ? null : (event.element as HTMLAudioElement),
            };
            return [...prev, tile];
          }
          const next = [...prev];
          next[idx] = isVideo
            ? { ...next[idx]!, videoElement: event.element as HTMLVideoElement }
            : { ...next[idx]!, audioElement: event.element as HTMLAudioElement };
          return next;
        });
      } else if (event.type === "track-removed") {
        // The tile itself (and its label) stays - only the specific media field that matches this
        // exact element is cleared, since camera/mic off is not the same as having left the room
        // (see the participant-disconnected branch below for when a tile is actually removed).
        setTiles((prev) =>
          prev.map((t) => {
            if (t.participantIdentity !== event.participantIdentity) return t;
            if (t.videoElement === event.element) return { ...t, videoElement: null };
            if (t.audioElement === event.element) return { ...t, audioElement: null };
            return t;
          })
        );
      } else if (event.type === "participant-disconnected") {
        setTiles((prev) => prev.filter((t) => t.participantIdentity !== event.participantIdentity));
      } else if (event.type === "disconnected") {
        setTiles([]);
      } else if (event.type === "local-media-error") {
        setMediaError({ message: event.message, actionable: event.actionable });
      }
    });
    return unsubscribe;
  }, []);

  // Cleanup on unmount - this provider is mounted once, for the app's whole lifetime
  // (SidePanelApp.tsx), so this only fires when the side panel itself closes - if it's closed
  // while still in a call, leave cleanly rather than leaking an open LiveKit connection and a
  // stale Realtime subscription.
  useEffect(() => {
    return () => {
      unsubscribePresenceRef.current?.();
      videoCallClient.leaveCall();
    };
  }, []);

  async function joinRoom(room: StudyRoom, options: { camera: boolean; microphone: boolean }) {
    setJoining(room.id);
    setJoinError(null);
    setMediaError(null);
    setSelectedParticipantIds(new Set());

    // Resolves the current user's id purely to seed a placeholder "You" tile immediately (see
    // below) - StudyRoomSessionProvider has no other reason to track who's signed in (that's
    // StudyRoomsBox.tsx's own signed-out-gate concern), so this is a fresh, self-contained lookup
    // rather than shared state.
    let selfUserId: string | null = null;
    try {
      const selfRes = await sendMessage<{
        ok: boolean;
        session?: { user: { id: string } } | null;
        error?: string;
      }>({ type: "AUTH_GET_SESSION" });
      if (selfRes.ok) selfUserId = selfRes.session?.user.id ?? null;
    } catch (err) {
      console.error("Failed to resolve current user before joining a study room", err);
    }

    // QA-discovered bug precedent (v3.3 QA pass, carried over from StudyRoomPanel.tsx): joining
    // with the camera AND mic both off never fires a local "track-added" at all, so no tile ever
    // existed for the local user to attach into. Seeding a tile for the local user here, before
    // joinCall even runs, means the same empty/labeled placeholder tile shows immediately
    // regardless of the pre-join camera/mic toggles - a later track-added for this identity fills
    // in videoElement/audioElement on this SAME entry (matched by participantIdentity), it doesn't
    // create a second one.
    setTiles(
      selfUserId
        ? [{ participantIdentity: selfUserId, isLocal: true, videoElement: null, audioElement: null }]
        : []
    );

    try {
      const { token } = await studyRoomApi.joinRoom(room.id);
      await videoCallClient.joinCall(room.id, token, {
        camera: options.camera,
        microphone: options.microphone,
      });

      const participantsRes = await sendMessage<{
        ok: boolean;
        participants?: RoomParticipant[];
        error?: string;
      }>({ type: "STUDY_ROOM_LIST_PARTICIPANTS", payload: { roomId: room.id } });
      if (!participantsRes.ok || !participantsRes.participants) {
        throw new Error(participantsRes.error ?? "Could not load who's currently in this room.");
      }
      setParticipants(new Map(participantsRes.participants.map((p) => [p.userId, p])));

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

  async function leaveRoom() {
    if (!joinedRoom) return;
    setLeaving(true);
    try {
      unsubscribePresenceRef.current?.();
      unsubscribePresenceRef.current = null;
      videoCallClient.leaveCall();
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "STUDY_ROOM_LEAVE",
        payload: { roomId: joinedRoom.id },
      });
      if (!res.ok) {
        throw new Error(res.error ?? "Could not record leaving this room.");
      }
    } catch (err) {
      // Local call/presence teardown above already ran regardless - a failure here only means
      // the server-side left_at write didn't land (e.g. offline), not that the user is still
      // visibly "in" the room from their own client's perspective.
      console.error("Failed to record leaving the study room", err);
    } finally {
      setJoinedRoom(null);
      setParticipants(new Map());
      setTiles([]);
      setMediaError(null);
      setSelectedParticipantIds(new Set());
      setLeaving(false);
    }
  }

  return (
    <StudyRoomSessionContext.Provider
      value={{
        joinedRoom,
        joining,
        joinError,
        leaving,
        participants,
        tiles,
        cameraOn,
        micOn,
        mediaError,
        selectedParticipantIds,
        joinRoom,
        leaveRoom,
        toggleCamera,
        toggleMic,
        toggleParticipantSelected,
        clearParticipantSelection,
      }}
    >
      {children}
    </StudyRoomSessionContext.Provider>
  );
}

export function useStudyRoomSession(): StudyRoomSessionValue {
  const ctx = useContext(StudyRoomSessionContext);
  if (!ctx) throw new Error("useStudyRoomSession must be used within a StudyRoomSessionProvider");
  return ctx;
}
