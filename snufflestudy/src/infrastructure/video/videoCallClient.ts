import { Room, RoomEvent, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";
import { MEDIA_PERMISSION_HELP_MESSAGE, isMediaPermissionError } from "../media/mediaPermissions";

// v2 Task 13: Study Rooms - the LiveKit room-join wrapper. Per this task's brief, this is "the
// one file any future video-provider swap should touch" - every livekit-client type/import stays
// contained here. studyRoomApi.ts never imports livekit-client at all (it only produces the
// roomId/token strings this file's joinCall() consumes); StudyRoomPanel.tsx only ever sees this
// file's own exported surface (plain strings, HTMLMediaElement, and the VideoCallEvent union
// below) - never a Room/RemoteTrack/RemoteParticipant/etc. type. A future swap to a different
// provider (Decision 6 names Daily.co/Twilio Video as the named alternatives) means rewriting
// this one file's internals to the same exported surface; nothing outside it should need to
// change.
//
// API confirmed against current LiveKit JS Client SDK docs/type declarations at build time
// (docs.livekit.io/reference/client-sdk-js/, node_modules/livekit-client@2.21.0's own .d.ts
// files) rather than guessed from memory, per this task's "confirm exact syntax against current
// docs" instruction:
// - `new Room(options)`, `room.connect(url, token, opts?)`, `room.disconnect(stopTracks?)`.
// - `room.localParticipant.setCameraEnabled(true)` / `.setMicrophoneEnabled(true)` - each
//   resolves with the resulting LocalTrackPublication (or undefined) and requests a browser
//   camera/mic permission prompt as a side effect.
// - `RoomEvent.TrackSubscribed`/`TrackUnsubscribed` fire on the Room with
//   (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant).
// - `RoomEvent.LocalTrackPublished`/`LocalTrackUnpublished` fire with
//   (publication: LocalTrackPublication, participant: LocalParticipant) - used here to surface
//   the local camera preview through the same "track-added"/"track-removed" event shape remote
//   tracks use, so StudyRoomPanel.tsx doesn't need two different code paths for "my own video"
//   vs. "a friend's video".
// - `Track.attach()` / `Track.attach(existingElement)` creates (or reuses) an HTMLVideoElement/
//   HTMLAudioElement wired to that track's MediaStream - this is what backs every element this
//   file hands out via VideoCallEvent.
//
// Isolation note: this module holds its LiveKit Room instance and listener registry as private
// module-level state (mirrors supabaseClient.ts's module-scoped singleton pattern) rather than a
// class instance, matching this file's own two exported free functions
// (joinCall/leaveCall: Promise<void>/void, per the plan's exact Interfaces signature) rather than
// an object API - there is only ever one active call at a time in this extension (one sidepanel,
// one Study Room joined at once), so a singleton is the right shape, not an under-justified
// simplification.

// The minimal event-subscription surface StudyRoomPanel.tsx needs to actually render remote
// participants' (and the local user's own) video/audio - the brief leaves the exact shape to this
// file's judgment, provided it stays contained here. A single tagged union (rather than several
// named callback props) keeps the panel's rendering logic to one switch/reducer instead of five
// separate handler props, and mirrors this codebase's other tagged-union event shapes (e.g.
// domain/rooms/studyRoom.ts's PresenceChangeEvent).
export type VideoCallEvent =
  | { type: "track-added"; participantIdentity: string; isLocal: boolean; element: HTMLMediaElement }
  | { type: "track-removed"; participantIdentity: string; isLocal: boolean; element: HTMLMediaElement }
  | { type: "participant-disconnected"; participantIdentity: string }
  | { type: "disconnected" }
  // QA-discovered bug (v3.2 Task 9): setCameraEnabled/setMicrophoneEnabled failing below used to
  // only console.error and otherwise degrade completely silently - a real join with no local
  // video/audio published looked identical, from the UI's perspective, to one where the panel
  // simply never got a chance to say why. `actionable` is true specifically for the Chrome
  // side-panel permission-prompt limitation (see mediaPermissions.ts) - StudyRoomPanel.tsx offers
  // the "open a tab to grant access" fix only then, not for a genuinely missing/broken device.
  | { type: "local-media-error"; kind: "camera" | "microphone"; message: string; actionable: boolean };

type VideoCallEventListener = (event: VideoCallEvent) => void;

let currentRoom: Room | null = null;
const listeners = new Set<VideoCallEventListener>();

function emit(event: VideoCallEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("videoCallClient event listener threw", err);
    }
  }
}

function handleTrackSubscribed(
  track: RemoteTrack,
  _publication: RemoteTrackPublication,
  participant: RemoteParticipant
): void {
  const element = track.attach();
  emit({ type: "track-added", participantIdentity: participant.identity, isLocal: false, element });
}

function handleTrackUnsubscribed(
  track: RemoteTrack,
  _publication: RemoteTrackPublication,
  participant: RemoteParticipant
): void {
  for (const element of track.detach()) {
    emit({ type: "track-removed", participantIdentity: participant.identity, isLocal: false, element });
  }
}

function handleParticipantDisconnected(participant: RemoteParticipant): void {
  emit({ type: "participant-disconnected", participantIdentity: participant.identity });
}

function handleDisconnected(): void {
  emit({ type: "disconnected" });
}

// Registers every Room-level listener this file cares about. Local camera/mic tracks are wired
// up separately, directly around the setCameraEnabled/setMicrophoneEnabled calls in joinCall
// below (rather than via RoomEvent.LocalTrackPublished) - those calls already hand back the
// resulting LocalTrackPublication synchronously, which is simpler than round-tripping through a
// room-level event for tracks this same function just requested.
function attachRoomListeners(room: Room): void {
  room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
  room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
  room.on(RoomEvent.Disconnected, handleDisconnected);
}

function detachRoomListeners(room: Room): void {
  room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
  room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
  room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
  room.off(RoomEvent.Disconnected, handleDisconnected);
}

// Connects to the LiveKit room named `roomId` (studyRoomApi.ts's joinRoom() mints `token` scoped
// to exactly this room name and the caller's own identity - see generate-livekit-token/index.ts's
// header comment for why the room name is the study_rooms.id uuid itself) using
// import.meta.env.WXT_LIVEKIT_URL, then publishes the local camera and microphone.
//
// Signature matches the plan's Interfaces line exactly (`joinCall(roomId: string, token: string):
// Promise<void>`) - the connected Room instance is intentionally NOT returned; callers only ever
// interact with this module through onVideoCallEvent/leaveCall, per the isolation requirement.
// `roomId` isn't otherwise used in this function body (the token alone is what LiveKit's connect
// call needs), but is kept in the signature both because the plan specifies it and because a
// future provider swap may need the room identifier explicitly rather than only implicitly via
// the token's own claims.
export async function joinCall(roomId: string, token: string): Promise<void> {
  void roomId;

  const url = import.meta.env.WXT_LIVEKIT_URL;
  if (!url) {
    throw new Error("Video calling is not configured (WXT_LIVEKIT_URL missing).");
  }

  // A prior call was never cleanly left - defensively tear it down first rather than leaking a
  // second live Room/WebSocket connection and a duplicate set of listeners.
  if (currentRoom) {
    leaveCall();
  }

  const room = new Room({ adaptiveStream: true, dynacast: true });
  attachRoomListeners(room);

  try {
    await room.connect(url, token);
  } catch (err) {
    detachRoomListeners(room);
    throw err;
  }

  currentRoom = room;

  // Publishes the local camera/mic - each call triggers the browser's own permission prompt as a
  // side effect and resolves with the resulting LocalTrackPublication. Camera/mic access failing
  // (permission denied, no device present) must not tear down the whole call - degrades to a
  // join with no local video/audio published rather than no call at all, consistent with this
  // codebase's established graceful-degradation posture for anything that can partially fail.
  try {
    const cameraPublication = await room.localParticipant.setCameraEnabled(true);
    const track = cameraPublication?.track;
    if (track) {
      const element = track.attach();
      emit({
        type: "track-added",
        participantIdentity: room.localParticipant.identity,
        isLocal: true,
        element,
      });
    }
  } catch (err) {
    console.error("Could not enable local camera", err);
    emit({
      type: "local-media-error",
      kind: "camera",
      message: isMediaPermissionError(err) ? MEDIA_PERMISSION_HELP_MESSAGE : String(err),
      actionable: isMediaPermissionError(err),
    });
  }

  try {
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (err) {
    console.error("Could not enable local microphone", err);
    emit({
      type: "local-media-error",
      kind: "microphone",
      message: isMediaPermissionError(err) ? MEDIA_PERMISSION_HELP_MESSAGE : String(err),
      actionable: isMediaPermissionError(err),
    });
  }
}

// Disconnects from the current call (if any) and clears local state. Safe to call when no call is
// active (a no-op) - StudyRoomPanel.tsx's "Leave" button and its own unmount cleanup both call
// this unconditionally.
export function leaveCall(): void {
  if (!currentRoom) return;
  const room = currentRoom;
  currentRoom = null;
  detachRoomListeners(room);
  // stopTracks defaults to true - releases the local camera/mic devices (turns off the browser's
  // "in use" indicator) rather than leaving them captured after the call ends.
  room.disconnect();
}

// Registers a listener for every VideoCallEvent this module emits; returns an unsubscribe
// function. Mirrors studyRoomApi.ts's subscribeToPresence(...) return-an-unsubscriber shape for
// consistency across this task's two "live callback" surfaces.
export function onVideoCallEvent(listener: VideoCallEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
