import { useEffect, useRef, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import type { RoomProducerTagBroadcast } from "../../infrastructure/backend/producerTagApi";
import type { StudyRoom, RoomParticipant, RoomInvitee } from "../../domain/rooms/studyRoom";
import type { ProducerTag } from "../../domain/rooms/producerTag";
import type { GroupMembership } from "../../infrastructure/backend/friendGroupApi";
import { ProducerTagRecorder } from "./ProducerTagRecorder";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
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

// v3.3 Task 13: the owner-only "Manage access" section for one room - lists the owner's friends
// (via GROUP_LIST_MINE -> GROUP_LIST_MEMBERS, the same picker pattern LockedPage.tsx/
// AccountPage.tsx already use, per this task's plan) with an add/remove toggle against each one,
// backed by STUDY_ROOM_INVITEE_ADD/REMOVE/STUDY_ROOM_INVITEES_LIST. A separate component (not
// inlined into the room-list <li> below) so its own friend/invitee fetch only ever runs for the
// one room currently expanded, not once per owned room on every render.
function ManageAccessSection({ roomId }: { roomId: string }) {
  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);

  const [inviteeIds, setInviteeIds] = useState<Set<string> | null>(null);
  const [inviteesError, setInviteesError] = useState<string | null>(null);

  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // v3.3 Task 8: resolves each friend's userId to their human_name (falling back to the raw id,
  // same as before this task, when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(friendIds ?? []);

  useEffect(() => {
    let cancelled = false;

    // Friend picker - same GROUP_LIST_MINE -> GROUP_LIST_MEMBERS pattern LockedPage.tsx/
    // AccountPage.tsx already use. Unlike LockedPage.tsx, this doesn't need selfUserId separately -
    // the caller only ever reaches this section already knowing they're this room's owner (the
    // room-list view below only renders this component when `room.ownerUserId === selfUserId`) -
    // but GROUP_LIST_MEMBERS still returns the caller's own membership row alongside everyone
    // else's, so it's filtered out the same way LockedPage.tsx does, by re-checking against
    // AUTH_GET_SESSION rather than assuming which id in the results is "self".
    sendMessage<{ ok: boolean; session?: { user: { id: string } } | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((sessionRes) => {
        if (cancelled) return;
        const selfId = sessionRes.ok ? (sessionRes.session?.user.id ?? null) : null;

        sendMessage<{ ok: boolean; memberships?: GroupMembership[]; error?: string }>({
          type: "GROUP_LIST_MINE",
        })
          .then((groupsRes) => {
            if (cancelled) return;
            if (!groupsRes.ok) {
              setFriendsError(groupsRes.error ?? "Could not load your friends.");
              return;
            }
            const memberships = groupsRes.memberships ?? [];
            if (memberships.length === 0) {
              setFriendIds([]);
              return;
            }
            Promise.all(
              memberships.map((m) =>
                sendMessage<{ ok: boolean; members?: GroupMembership[]; error?: string }>({
                  type: "GROUP_LIST_MEMBERS",
                  payload: { groupId: m.groupId },
                })
              )
            )
              .then((memberResponses) => {
                if (cancelled) return;
                const ids = new Set<string>();
                for (const memberRes of memberResponses) {
                  if (!memberRes.ok || !memberRes.members) continue;
                  for (const member of memberRes.members) {
                    if (member.userId !== selfId) ids.add(member.userId);
                  }
                }
                setFriendIds([...ids]);
              })
              .catch((err) => {
                console.error("Failed to load group members for the invite picker", err);
                if (!cancelled) setFriendsError(err instanceof Error ? err.message : String(err));
              });
          })
          .catch((err) => {
            console.error("Failed to load groups for the invite picker", err);
            if (!cancelled) setFriendsError(err instanceof Error ? err.message : String(err));
          });
      })
      .catch((err) => {
        console.error("Failed to load current user for the invite picker", err);
        if (!cancelled) setFriendsError(err instanceof Error ? err.message : String(err));
      });

    sendMessage<{ ok: boolean; invitees?: RoomInvitee[]; error?: string }>({
      type: "STUDY_ROOM_INVITEES_LIST",
      payload: { roomId },
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.invitees) {
          setInviteesError(res.error ?? "Could not load who's currently invited.");
          return;
        }
        setInviteeIds(new Set(res.invitees.map((i) => i.userId)));
      })
      .catch((err) => {
        console.error("Failed to load room invitees", err);
        if (!cancelled) setInviteesError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  function handleToggleInvite(friendUserId: string, currentlyInvited: boolean) {
    setBusyUserId(friendUserId);
    setToggleError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: currentlyInvited ? "STUDY_ROOM_INVITEE_REMOVE" : "STUDY_ROOM_INVITEE_ADD",
      payload: { roomId, userId: friendUserId },
    })
      .then((res) => {
        if (!res.ok) {
          setToggleError(res.error ?? "Could not update this invite.");
          return;
        }
        setInviteeIds((prev) => {
          const next = new Set(prev ?? []);
          if (currentlyInvited) {
            next.delete(friendUserId);
          } else {
            next.add(friendUserId);
          }
          return next;
        });
      })
      .catch((err) => {
        console.error("Failed to update a room invite", err);
        setToggleError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusyUserId(null));
  }

  return (
    <div className="study-room-panel__manage-access">
      {friendsError && <p role="alert">Couldn't load your friends: {friendsError}.</p>}
      {inviteesError && <p role="alert">Couldn't load invitees: {inviteesError}.</p>}
      {friendIds === null || inviteeIds === null ? (
        !friendsError && !inviteesError && <p>Loading…</p>
      ) : friendIds.length === 0 ? (
        <p>No friends available to invite yet - add a friend first.</p>
      ) : (
        <ul>
          {friendIds.map((friendId) => {
            const invited = inviteeIds.has(friendId);
            return (
              <li key={friendId}>
                <span>{displayName(friendId)}</span>
                <button
                  type="button"
                  onClick={() => handleToggleInvite(friendId, invited)}
                  disabled={busyUserId === friendId}
                >
                  {busyUserId === friendId ? "Updating…" : invited ? "Remove access" : "Invite"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {toggleError && <p role="alert">{toggleError}</p>}
    </div>
  );
}

// QA-discovered bug (v3.3 QA pass): the previous design tracked video tiles with a persistent
// `useRef<Map<...>>` and manually created/appended/removed raw DOM nodes into a single shared
// `gridRef` div, entirely outside React's own rendering. That's inherently racy - it depends on
// events (track-added/track-removed/participant-disconnected) arriving in whatever order the
// network/negotiation happens to produce them, with the ref-based Map surviving across entire
// leave/rejoin cycles (nothing ever cleared it), and a manual "did gridRef mount yet" reattachment
// effect trying to paper over just one specific ordering gap. Real two-account testing found
// multiple different visible failures depending on exact timing - inconsistent enough that no
// single point-fix in the old design converged on correct behavior.
//
// This tile is who owns "who has a tile and what's inside it" as real React state instead
// (`tiles` below) - React's own reconciliation (keyed by participantIdentity) now decides
// deterministically when each tile's container actually exists in the DOM, which is what makes
// this component's OWN effects below race-free: React never runs an effect before the element it
// targets has been committed, so `containerRef.current` is guaranteed non-null by the time either
// effect below runs, regardless of what order track-added events arrived in relative to any other
// render. Swapping `tile.videoElement`/`tile.audioElement` to a genuinely NEW element (e.g. a
// resubscription) changes this effect's own dependency, so React runs its cleanup (removing the
// stale element) before re-running with the new one - ordering React already guarantees, not
// something this file has to hand-manage the way the old design tried to.
interface Tile {
  participantIdentity: string;
  isLocal: boolean;
  videoElement: HTMLVideoElement | null;
  audioElement: HTMLAudioElement | null;
}

function StudyRoomVideoTile({ tile, label }: { tile: Tile; label: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const element = tile.videoElement;
    if (!container || !element) return;
    container.appendChild(element);
    return () => {
      element.remove();
    };
  }, [tile.videoElement]);

  useEffect(() => {
    const container = containerRef.current;
    const element = tile.audioElement;
    if (!container || !element) return;
    container.appendChild(element);
    return () => {
      element.remove();
    };
  }, [tile.audioElement]);

  return (
    <div
      ref={containerRef}
      className="study-room-panel__tile"
      data-participant={tile.participantIdentity}
    >
      <span className="study-room-panel__tile-label">{label}</span>
    </div>
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

  // v3.3 Task 6: archiving is an owner-only action (see the migration's "owner can archive their
  // own room" UPDATE policy) - archivingId tracks in-flight-per-room the same way `joining` does,
  // so archiving one room's button doesn't disable every other room's Archive/Join buttons too.
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // v3.3 Task 13: at most one room's "Manage access" section is expanded at a time, mirroring
  // HistoryPage.tsx's identical single-expanded-id pattern (expandedSessionId) rather than a
  // per-room boolean map - there's no need for more than one open at once, and this keeps
  // ManageAccessSection's own friend/invitee fetch from running once per owned room on every
  // render.
  const [manageAccessRoomId, setManageAccessRoomId] = useState<string | null>(null);

  const [participants, setParticipants] = useState<Map<string, RoomParticipant>>(new Map());

  // v3.3 Task 8: resolves each participant's userId to their human_name (falling back to the raw
  // id, same as before this task, when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames([...participants.keys()]);

  // v2 Task 14: producer tags broadcast live into the currently-joined room (Part D - Realtime
  // Broadcast, not the friend-poll alarm; see producerTagApi.ts's sendToRoom/
  // subscribeToRoomProducerTags). Cleared on join/leave, same as `participants` above - this is a
  // live view of "what's been broadcast while I've been in THIS room", not a persisted history
  // (matching this task's DoD, which only asks for "all CURRENT participants hear it").
  const [roomTags, setRoomTags] = useState<RoomProducerTagEntry[]>([]);
  const [tagSendBusy, setTagSendBusy] = useState(false);
  const [tagSendError, setTagSendError] = useState<string | null>(null);

  // Who has a video tile and what's inside it - see the StudyRoomVideoTile/Tile comment above for
  // why this is real React state now, not a persistent ref-based Map. Explicitly reset to []
  // whenever a call session actually ends (handleLeaveRoom, and the catch branch of a failed
  // handleJoinRoom below) - QA-discovered bug (v3.3 QA pass): the old ref-based Map was NEVER
  // cleared across an entire component lifetime, so a stale tile (and its now-defunct media
  // elements) from a PREVIOUS join could survive into a later one for any participant identity
  // that recurred (e.g. rejoining the same room, or the same friend being in a later room too).
  const [tiles, setTiles] = useState<Tile[]>([]);

  const unsubscribePresenceRef = useRef<(() => void) | null>(null);
  const unsubscribeRoomTagsRef = useRef<(() => void) | null>(null);

  // QA-discovered bug (v3.2 Task 9): local-media-error used to have nowhere to go but
  // console.error - a real join with no local video/audio published looked identical to one that
  // never got a chance to say why. actionable === true specifically means "grant camera/mic
  // access from a full tab" (mediaPermissions.ts) is a real fix for this failure, not just noise.
  const [mediaError, setMediaError] = useState<{ message: string; actionable: boolean } | null>(null);

  // v3.3 Task 9: one pair of flags does double duty, matching this component's existing preference
  // for simple, shared local state over parallel-but-separate pieces of state. Before joining, they
  // drive the two "join with camera/mic on" checkboxes below (default both true, preserving the
  // pre-Task-9 "always publish both" behavior) and are read once by handleJoinRoom to build
  // joinCall's `initial` param. Once joined, the SAME flags become the two in-room toggle buttons'
  // on/off label, updated optimistically on click - per this task's brief, LiveKit's own publication
  // state is the long-term source of truth, but simple local state is sufficient here.
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  // Fire-and-forget the actual LiveKit toggle after optimistically flipping the button's label -
  // videoCallClient.setCameraEnabled/setMicrophoneEnabled never reject (a failure, e.g. hitting the
  // Chrome side-panel getUserMedia permission wall on a first-time camera-on toggle, is caught
  // inside that module and re-emitted as the same "local-media-error" event join-time failures use,
  // which the existing mediaError listener below already renders) - this .catch is defensive only,
  // matching this codebase's standing rule against a bare async call in a UI handler.
  function handleToggleCamera() {
    const next = !cameraOn;
    setCameraOn(next);
    videoCallClient.setCameraEnabled(next).catch((err) => {
      console.error("Failed to toggle camera", err);
    });
  }

  function handleToggleMic() {
    const next = !micOn;
    setMicOn(next);
    videoCallClient.setMicrophoneEnabled(next).catch((err) => {
      console.error("Failed to toggle microphone", err);
    });
  }

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

  // Video event wiring - registered once for the component's lifetime (videoCallClient is a
  // singleton with at most one active call, so there's nothing to re-subscribe per room). Updates
  // `tiles` state rather than touching the DOM directly - StudyRoomVideoTile above is what actually
  // inserts each tile's media elements, once React has committed that tile's own container.
  useEffect(() => {
    const unsubscribe = videoCallClient.onVideoCallEvent((event) => {
      if (event.type === "track-added") {
        const isVideo = event.element instanceof HTMLVideoElement;
        event.element.classList.add("study-room-panel__media");
        // Local video is muted client-side to avoid echoing the user's own mic back at them -
        // LiveKit's own audio track publishing to the room is unaffected by this element-level
        // mute, which only controls local HTMLMediaElement playback. v3.3 Task 3: the local
        // preview is also mirrored (display-only, via a CSS transform on this element) so it
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
        // exact element is cleared, matching the pre-refactor behavior of leaving a labeled,
        // empty tile in place for a participant whose camera/mic is off but who hasn't actually
        // disconnected (see the participant-disconnected branch below for when a tile is actually
        // removed).
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

  // v3.3 Task 6: archives a room this user owns - removed from every user's STUDY_ROOM_LIST
  // (listRooms()'s new .is("archived_at", null) filter) immediately, so this optimistically drops
  // it from the local `rooms` list on success rather than waiting on a full loadRooms() re-fetch,
  // same "update local state directly" convention handleCreateRoom already uses on success.
  function handleArchiveRoom(room: StudyRoom) {
    setArchivingId(room.id);
    setArchiveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "STUDY_ROOM_ARCHIVE",
      payload: { roomId: room.id },
    })
      .then((res) => {
        if (!res.ok) {
          setArchiveError(res.error ?? "Could not archive that room.");
          return;
        }
        setRooms((prev) => (prev ?? []).filter((r) => r.id !== room.id));
      })
      .catch((err) => {
        console.error("Failed to archive study room", err);
        setArchiveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setArchivingId(null));
  }

  async function handleJoinRoom(room: StudyRoom) {
    setJoining(room.id);
    setJoinError(null);
    setMediaError(null);
    // QA-discovered bug (v3.3 QA pass): unlike `participants` (which gets a fresh, complete
    // replacement from this same function's participants fetch below), `tiles` is only ever
    // incrementally updated by track events - there's no later call that overwrites it wholesale.
    // A stale tile (and its now-defunct media elements) from a PREVIOUS join session would
    // otherwise survive into this new one for any participant identity that recurs. Reset here,
    // at the START of every join attempt, rather than relying solely on handleLeaveRoom's own
    // reset below - this covers session starts that don't follow a normal leave too (e.g. the
    // very first join, or recovering from an earlier failed join's partial state).
    setTiles([]);
    try {
      const { token } = await studyRoomApi.joinRoom(room.id);
      // v3.3 Task 9: cameraOn/micOn reflect the room-list view's two pre-join toggles (default
      // both true) - passed straight through as joinCall's `initial` param.
      await videoCallClient.joinCall(room.id, token, { camera: cameraOn, microphone: micOn });

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
      setTiles([]);
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

        <div className="study-room-panel__grid">
          {tiles.map((tile) => (
            <StudyRoomVideoTile
              key={tile.participantIdentity}
              tile={tile}
              label={tile.isLocal ? "You" : displayName(tile.participantIdentity)}
            />
          ))}
        </div>

        <div className="study-room-panel__media-toggles">
          <button type="button" onClick={handleToggleCamera}>
            Camera: {cameraOn ? "On" : "Off"}
          </button>
          <button type="button" onClick={handleToggleMic}>
            Mic: {micOn ? "On" : "Off"}
          </button>
        </div>

        <section className="study-room-panel__presence">
          <h3>In this room ({participants.size})</h3>
          <ul>
            {[...participants.values()].map((p) => (
              <li key={p.userId}>{displayName(p.userId)}</li>
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
            placeholder="e.g. Thursday study session"
            disabled={creating}
          />
        </label>
        <button type="button" onClick={handleCreateRoom} disabled={creating || !newRoomName.trim()}>
          {creating ? "Creating…" : "Create room"}
        </button>
        {createError && <p role="alert">Could not create room: {createError}</p>}
      </section>

      <section className="study-room-panel__media-toggles">
        <label>
          <input type="checkbox" checked={cameraOn} onChange={(e) => setCameraOn(e.target.checked)} />
          Join with camera on
        </label>
        <label>
          <input type="checkbox" checked={micOn} onChange={(e) => setMicOn(e.target.checked)} />
          Join with mic on
        </label>
      </section>

      <section className="study-room-panel__list">
        <h3>Rooms among your friends</h3>
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
                {room.ownerUserId === selfUserId && (
                  <button
                    type="button"
                    onClick={() => handleArchiveRoom(room)}
                    disabled={archivingId === room.id}
                  >
                    {archivingId === room.id ? "Archiving…" : "Archive this room"}
                  </button>
                )}
                {room.ownerUserId === selfUserId && (
                  <button
                    type="button"
                    onClick={() =>
                      setManageAccessRoomId((prev) => (prev === room.id ? null : room.id))
                    }
                  >
                    {manageAccessRoomId === room.id ? "Hide manage access" : "Manage access"}
                  </button>
                )}
                {room.ownerUserId === selfUserId && manageAccessRoomId === room.id && (
                  <ManageAccessSection roomId={room.id} />
                )}
              </li>
            ))}
          </ul>
        )}
        {joinError && <p role="alert">{joinError}</p>}
        {archiveError && <p role="alert">{archiveError}</p>}
      </section>

      <button type="button" onClick={loadRooms}>
        Refresh
      </button>
    </div>
  );
}
