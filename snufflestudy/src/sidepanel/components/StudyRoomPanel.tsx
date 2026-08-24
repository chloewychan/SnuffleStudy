import { useEffect, useRef, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import type { RoomProducerTagBroadcast } from "../../infrastructure/backend/producerTagApi";
import type { StudyRoom, RoomParticipant } from "../../domain/rooms/studyRoom";
import type { ProducerTag } from "../../domain/rooms/producerTag";
import { ProducerTagRecorder } from "./ProducerTagRecorder";
import { SignInForm } from "../../shared/ui/SignInForm";
import { openMediaPermissionTab } from "../../infrastructure/media/mediaPermissions";

// v2 Task 13: Study Rooms.
//
// Room list/create/leave (STUDY_ROOM_LIST/STUDY_ROOM_CREATE/STUDY_ROOM_LEAVE/
// STUDY_ROOM_LIST_PARTICIPANTS) all go through sendMessage()/messageRouter.ts, the same
// message-passing-only convention every other panel in this codebase follows
// (FriendGroupPanel.tsx/UnlockRequestPanel.tsx/TempPasscodePanel.tsx).
//
// Fix round 1 (Important, code review): an earlier version of this component called
// studyRoomApi.ts's createRoom/listRooms/leaveRoom/listParticipants directly too, justified by
// the same reasoning that genuinely does apply to joinRoom/subscribeToPresence below - review
// correctly flagged that the justification didn't actually extend that far, since those four are
// plain one-shot DB operations with no live-callback or DOM/media coupling. Narrowed to exactly
// two direct exceptions, matching studyRoomApi.ts's own header comment:
//
// - `studyRoomApi.joinRoom` is called directly because its LiveKit token has to flow straight
//   into `videoCallClient.joinCall(roomId, token)` below, which MUST run in this component's real
//   DOM context (camera/mic access) - a browser/MV3 constraint, not a style choice.
// - `studyRoomApi.subscribeToPresence` is called directly because its live-callback shape (a
//   Supabase Realtime subscription that keeps firing for as long as this component is mounted)
//   has no fit in this codebase's one-shot request/response or alarm-driven-poll message-passing
//   surface - piping it through messageRouter.ts would need a new persistent port protocol that
//   would exist to serve only this one feature.
//
// `videoCallClient.ts` itself is always called directly (never a message) - it's a pure client-
// side wrapper around a real DOM connection, not a backend call.
//
// v2 Task 14: `producerTagApi.subscribeToRoomProducerTags`/`downloadTagAudio` are ALSO called
// directly here, for the same two reasons studyRoomApi.subscribeToPresence/joinRoom are (see
// producerTagApi.ts's own header comment): a live Realtime callback has no fit in the
// message-passing surface, and a downloaded audio Blob must flow straight into this component's
// own <audio> element. uploadTag/sendToFriend/sendToRoom remain message-routed (PRODUCER_TAG_*),
// same as STUDY_ROOM_CREATE/LIST/LEAVE/LIST_PARTICIPANTS above.

// The shape this panel tracks per received room broadcast - starts as just the broadcast payload,
// filled in with audioUrl/durationMs once PRODUCER_TAG_FETCH_BY_ID resolves (see
// handleIncomingRoomTag below). Kept local to this file (not a domain/*Api.ts export) since it's
// purely a "what does this one component need to render a list item" shape, same category as
// applyPresenceEvent's Map<string, RoomParticipant> above.
interface RoomProducerTagEntry {
  tagId: string;
  senderUserId: string;
  sentAt: string;
  audioUrl: string | null;
  durationMs: number | null;
}

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

// v2 Task 14: one producer tag received live in the currently-joined room. Play is lazy (only
// fetched once clicked, same as FriendGroupPanel.tsx's IncomingProducerTagCard) - and only
// possible once audioUrl has resolved (see handleIncomingRoomTag above), which can lag the initial
// broadcast by one round trip.
function RoomProducerTagItem({ tag }: { tag: RoomProducerTagEntry }) {
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handlePlay() {
    if (!tag.audioUrl) return;
    setLoading(true);
    setError(null);
    producerTagApi
      .downloadTagAudio(tag.audioUrl)
      .then((blob) => setPlaybackUrl(URL.createObjectURL(blob)))
      .catch((err) => {
        console.error("Failed to download producer tag audio", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  return (
    <li>
      <span>
        From {tag.senderUserId}
        {tag.durationMs !== null ? ` — ${Math.round(tag.durationMs / 1000)}s` : ""}
      </span>
      {playbackUrl ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- a short voice tag, not video
        <audio src={playbackUrl} controls autoPlay />
      ) : (
        <button type="button" onClick={handlePlay} disabled={loading || !tag.audioUrl}>
          {loading ? "Loading…" : "Play"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

export function StudyRoomPanel({ onClose }: StudyRoomPanelProps) {
  // v3.2 Task 2: this panel had no auth check at all before this task - mirrors the auth-check
  // half of FriendGroupPanel.tsx's loadFriends() (AUTH_GET_SESSION -> selfUserId), not its
  // group-membership fetch, which this panel doesn't need. `selfLoaded` (which
  // TempPasscodePanel.tsx/UnlockRequestPanel.tsx don't currently have) is added here so the
  // signed-out gate below only renders once sign-in status is actually known - without it, every
  // mount (including a signed-in user's) would briefly render the sign-in prompt before flipping
  // to the real room list once AUTH_GET_SESSION resolves, since this gate swaps the panel's
  // entire body rather than filtering an already-rendered list the way the other three panels do.
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [selfLoaded, setSelfLoaded] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);

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

  // v2 Task 14: producer tags broadcast live into the currently-joined room (Part D - Realtime
  // Broadcast, not the friend-poll alarm; see producerTagApi.ts's sendToRoom/
  // subscribeToRoomProducerTags). Cleared on join/leave, same as `participants` above - this is a
  // live view of "what's been broadcast while I've been in THIS room", not a persisted history
  // (matching this task's DoD, which only asks for "all CURRENT participants hear it").
  const [roomTags, setRoomTags] = useState<RoomProducerTagEntry[]>([]);
  const [tagSendBusy, setTagSendBusy] = useState(false);
  const [tagSendError, setTagSendError] = useState<string | null>(null);

  // Where LiveKit's own attach()'d <video>/<audio> elements get appended - see
  // videoCallClient.ts's VideoCallEvent union. Keyed by participant identity so a track-removed
  // event can find and detach exactly the right element without touching anyone else's tile.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const unsubscribePresenceRef = useRef<(() => void) | null>(null);
  const unsubscribeRoomTagsRef = useRef<(() => void) | null>(null);

  // QA-discovered bug (v3.2 Task 9): local-media-error used to have nowhere to go but
  // console.error - a real join with no local video/audio published looked identical to one that
  // never got a chance to say why. actionable === true specifically means "grant camera/mic
  // access from a full tab" (mediaPermissions.ts) is a real fix for this failure, not just noise.
  const [mediaError, setMediaError] = useState<{ message: string; actionable: boolean } | null>(null);

  function loadRooms() {
    setLoadError(null);
    sendMessage<{ ok: boolean; rooms?: StudyRoom[]; error?: string }>({ type: "STUDY_ROOM_LIST" })
      .then((res) => {
        if (!res.ok || !res.rooms) {
          setLoadError(res.error ?? "Could not load rooms.");
          return;
        }
        setRooms(res.rooms);
      })
      .catch((err) => {
        console.error("Failed to load study rooms", err);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }

  // v3.2 Task 2: mirrors TempPasscodePanel.tsx's/UnlockRequestPanel.tsx's identical loadSelf()
  // shape exactly (same AUTH_GET_SESSION response type, same ok/error handling).
  function loadSelf() {
    setSelfError(null);
    sendMessage<{ ok: boolean; session?: { user: { id: string } } | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (!res.ok) {
          setSelfError(res.error ?? "Could not verify your sign-in status.");
          return;
        }
        setSelfUserId(res.session?.user.id ?? null);
      })
      .catch((err) => {
        console.error("Failed to load current user for study rooms", err);
        setSelfError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSelfLoaded(true));
  }

  useEffect(() => {
    loadSelf();
    loadRooms();
  }, []);

  // QA-discovered bug (v3.2 Task 9): the joined-room view (and its <div ref={gridRef}> grid
  // container below) only mounts once handleJoinRoom calls setJoinedRoom(room) - but
  // videoCallClient.joinCall publishes the local camera/mic and emits "track-added" for them
  // SYNCHRONOUSLY, DURING the call, well before that happens. At that moment gridRef.current is
  // still null, so the track-added handler below silently drops the tile via `?.appendChild`
  // (no throw, no error - it just never entered the DOM). Every real join therefore lost its own
  // camera/mic preview, deterministically, every time - and any remote participant whose track
  // arrived in that same window (e.g. one already publishing when this client connects) would
  // hit the identical gap. Fix: whenever the grid container actually becomes available (i.e.
  // joinedRoom flips true and this component re-renders), re-attach any tile that was already
  // created but never made it into the live DOM - independent of exactly when track-added fired
  // relative to the mount, so this doesn't just narrow the race, it removes it.
  useEffect(() => {
    if (!joinedRoom) return;
    for (const tile of tileRefs.current.values()) {
      if (tile.parentElement !== gridRef.current) {
        gridRef.current?.appendChild(tile);
      }
    }
  }, [joinedRoom]);

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
      } else if (event.type === "local-media-error") {
        setMediaError({ message: event.message, actionable: event.actionable });
      }
    });
    return unsubscribe;
  }, []);

  // Cleanup on unmount - if the panel is closed/navigated away from while still in a call, leave
  // cleanly rather than leaking an open LiveKit connection and a stale Realtime subscription.
  useEffect(() => {
    return () => {
      unsubscribePresenceRef.current?.();
      unsubscribeRoomTagsRef.current?.();
      videoCallClient.leaveCall();
    };
  }, []);

  // v2 Task 14: a live broadcast only ever carries tagId/roomId/senderUserId/sentAt (see
  // RoomProducerTagBroadcast's own comment on why audioUrl/durationMs are deliberately NOT part of
  // the payload) - this resolves the rest via PRODUCER_TAG_FETCH_BY_ID (message-routed, a plain
  // CRUD read) so the entry becomes playable. Added to the list immediately (with audioUrl/
  // durationMs null) so the UI shows "someone sent a tag" right away rather than waiting on a
  // second round trip before anything appears at all; filled in once the fetch resolves.
  function handleIncomingRoomTag(event: RoomProducerTagBroadcast) {
    setRoomTags((prev) => [
      ...prev,
      { tagId: event.tagId, senderUserId: event.senderUserId, sentAt: event.sentAt, audioUrl: null, durationMs: null },
    ]);
    sendMessage<{ ok: boolean; tag?: ProducerTag | null; error?: string }>({
      type: "PRODUCER_TAG_FETCH_BY_ID",
      payload: { tagId: event.tagId },
    })
      .then((res) => {
        if (!res.ok || !res.tag) return;
        const tag = res.tag;
        setRoomTags((prev) =>
          prev.map((entry) =>
            entry.tagId === event.tagId
              ? { ...entry, audioUrl: tag.audioUrl, durationMs: tag.durationMs }
              : entry
          )
        );
      })
      .catch((err) => console.error("Failed to resolve an incoming producer tag broadcast", err));
  }

  // v2 Task 14: record -> upload -> send-to-room, in one call from ProducerTagRecorder's onSend.
  // uploadTag/sendToRoom both go through messageRouter.ts (PRODUCER_TAG_UPLOAD then
  // PRODUCER_TAG_SEND_TO_ROOM, which also broadcasts - see producerTagApi.ts's sendToRoom
  // comment); blobToBase64 is a direct, pure-browser-API call (not a backend call).
  async function handleSendProducerTagToRoom(blob: Blob, durationMs: number) {
    if (!joinedRoom) return;
    setTagSendBusy(true);
    setTagSendError(null);
    try {
      const audioBase64 = await producerTagApi.blobToBase64(blob);
      const uploadRes = await sendMessage<{ ok: boolean; tag?: ProducerTag; error?: string }>({
        type: "PRODUCER_TAG_UPLOAD",
        payload: { audioBase64, mimeType: blob.type || "audio/webm", durationMs },
      });
      if (!uploadRes.ok || !uploadRes.tag) {
        throw new Error(uploadRes.error ?? "Could not upload this recording.");
      }

      const sendRes = await sendMessage<{ ok: boolean; error?: string }>({
        type: "PRODUCER_TAG_SEND_TO_ROOM",
        payload: { tagId: uploadRes.tag.id, roomId: joinedRoom.id },
      });
      if (!sendRes.ok) {
        throw new Error(sendRes.error ?? "Could not send this tag to the room.");
      }
    } catch (err) {
      console.error("Failed to send producer tag to room", err);
      setTagSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setTagSendBusy(false);
    }
  }

  function handleCreateRoom() {
    const trimmed = newRoomName.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateError(null);
    sendMessage<{ ok: boolean; room?: StudyRoom; error?: string }>({
      type: "STUDY_ROOM_CREATE",
      payload: { name: trimmed },
    })
      .then((res) => {
        if (!res.ok || !res.room) {
          setCreateError(res.error ?? "Could not create that room.");
          return;
        }
        setNewRoomName("");
        setRooms((prev) => [res.room!, ...(prev ?? [])]);
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
    setMediaError(null);
    try {
      const { token } = await studyRoomApi.joinRoom(room.id);
      await videoCallClient.joinCall(room.id, token);

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
      setRoomTags([]);
      unsubscribeRoomTagsRef.current = producerTagApi.subscribeToRoomProducerTags(
        room.id,
        handleIncomingRoomTag
      );

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
      unsubscribeRoomTagsRef.current?.();
      unsubscribeRoomTagsRef.current = null;
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
      setRoomTags([]);
      setTagSendError(null);
      setMediaError(null);
      setLeaving(false);
    }
  }

  // v3.2 Task 2: signed out, there's nothing this panel can show - creating/joining/listing
  // rooms all require an authenticated user (studyRoomApi.ts's requireUserId()). Gated on
  // `selfLoaded` (not just `selfUserId === null`) so a signed-in user never sees this prompt
  // flash before the AUTH_GET_SESSION round trip resolves, and on `!selfError` so a failed/
  // rejected AUTH_GET_SESSION call (connection lost, etc. - genuinely unknown sign-in state)
  // falls through to the normal view's own error handling (loadRooms()'s STUDY_ROOM_LIST call
  // surfaces the same underlying failure there) instead of asserting "sign in" when the real
  // answer is "couldn't check." No `onSkip` - there's nothing to skip to from inside a
  // permanently-embedded panel (FriendsTab.tsx composes this with a no-op onClose, same as the
  // other three gated panels).
  if (selfLoaded && selfUserId === null && !selfError) {
    return (
      <div className="study-room-panel">
        <header className="study-room-panel__header">
          <h2>Study Rooms</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {selfError && <p role="alert">Couldn't verify sign-in: {selfError}.</p>}
        <div className="study-room-panel__sign-in">
          <p>Sign in to create or join a study room with your friends.</p>
          <SignInForm
            onSignedIn={(session) => {
              setSelfUserId(session.user.id);
              loadRooms();
            }}
          />
        </div>
      </div>
    );
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
        {mediaError && (
          <p role="alert">
            {mediaError.message}
            {mediaError.actionable && (
              <>
                {" "}
                <button type="button" onClick={openMediaPermissionTab}>
                  Open a tab to grant access
                </button>
              </>
            )}
          </p>
        )}

        <section className="study-room-panel__producer-tags">
          <h3>Producer tags</h3>
          <ProducerTagRecorder
            onSend={handleSendProducerTagToRoom}
            sending={tagSendBusy}
            sendLabel="Send to room"
          />
          {tagSendError && <p role="alert">Tag not sent: {tagSendError}</p>}

          {roomTags.length === 0 && <p>No producer tags sent to this room yet.</p>}
          {roomTags.length > 0 && (
            <ul className="study-room-panel__producer-tag-list">
              {roomTags.map((tag) => (
                <RoomProducerTagItem key={tag.tagId} tag={tag} />
              ))}
            </ul>
          )}
        </section>

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
