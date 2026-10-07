import { useEffect, useId, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { StudyRoom, RoomInvitee } from "../../domain/rooms/studyRoom";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";
import { Input } from "./ui/Input";
import { ButtonBool } from "./ui/ButtonBool";
import { ButtonSmall } from "./ui/ButtonSmall";
import { ButtonLarge } from "./ui/ButtonLarge";
import { ButtonLargeIcon } from "./ui/ButtonLargeIcon";
import { ButtonIcon } from "./ui/ButtonIcon";
import { Modal } from "./ui/Modal";

// The Study tab's list/create/manage-access box. Room list items are click-to-select (single
// selection) rather than each carrying its own Join button - one "Join study room" button below
// the list joins whichever room is currently selected, via useStudyRoomSession().joinRoom().
// "Archive Study Room" lives inside the ManageAccessModal popup, opened via each owned room's
// own "options" icon.
//
// The joined-room view lives separately, in StudyRoomFooter.tsx - a persistent app-shell footer
// (AppFooter.tsx) that survives a tab switch. This box only ever shows the room
// list/create/manage-access UI, never a joined room.

interface StudyRoomsBoxProps {
  // No current caller passes onClose (StudyTab.tsx mounts this with nowhere to close to), kept
  // optional rather than removed: a future caller with somewhere real to close to can still use
  // it, and omitting it here means no dead button renders instead of a fake no-op one.
  onClose?: () => void;
}

// A modal, remove-only per its design (a trash icon per already-invited friend, no "Invite"
// affordance): inviting happens exclusively from the Friends tab's "Add to Room" bulk action
// (FriendsBox.tsx), which sends the same STUDY_ROOM_INVITEE_ADD message.
//
// Archiving itself (the STUDY_ROOM_ARCHIVE call, the archivingId/archiveError state) lives in
// the parent (StudyRoomsBox) - only one room's modal is ever open at a time, so a single shared
// archiveError is unambiguous.
function ManageAccessModal({
  roomId,
  roomName,
  archiving,
  archiveError,
  onArchive,
  onClose,
}: {
  roomId: string;
  roomName: string;
  archiving: boolean;
  archiveError: string | null;
  onArchive: () => void;
  onClose: () => void;
}) {
  const [inviteeIds, setInviteeIds] = useState<string[] | null>(null);
  const [inviteesError, setInviteesError] = useState<string | null>(null);

  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Resolves each invitee's userId to their human_name (falling back to the raw id when no
  // profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(inviteeIds ?? []);

  useEffect(() => {
    let cancelled = false;

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
        setInviteeIds(res.invitees.map((i) => i.userId));
      })
      .catch((err) => {
        console.error("Failed to load room invitees", err);
        if (!cancelled) setInviteesError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  function handleRemoveInvitee(friendUserId: string) {
    setBusyUserId(friendUserId);
    setRemoveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "STUDY_ROOM_INVITEE_REMOVE",
      payload: { roomId, userId: friendUserId },
    })
      .then((res) => {
        if (!res.ok) {
          setRemoveError(res.error ?? "Could not remove that invite.");
          return;
        }
        setInviteeIds((prev) => (prev ? prev.filter((id) => id !== friendUserId) : prev));
      })
      .catch((err) => {
        console.error("Failed to remove a room invite", err);
        setRemoveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusyUserId(null));
  }

  return (
    <Modal title={roomName} onClose={onClose}>
      {inviteesError && <p role="alert">Couldn't load invitees: {inviteesError}.</p>}
      {inviteeIds === null && !inviteesError && <p>Loading…</p>}
      {inviteeIds !== null && inviteeIds.length === 0 && !inviteesError && (
        <p>Nobody else is invited to this room yet.</p>
      )}
      {inviteeIds !== null && inviteeIds.length > 0 && (
        <ul className="manage-access-modal__list">
          {inviteeIds.map((friendId) => (
            <li key={friendId}>
              <span>{displayName(friendId)}</span>
              <ButtonIcon
                icon="trash"
                aria-label={busyUserId === friendId ? "Removing…" : `Remove ${displayName(friendId)}`}
                onClick={() => handleRemoveInvitee(friendId)}
                disabled={busyUserId === friendId}
              />
            </li>
          ))}
        </ul>
      )}
      {removeError && <p role="alert">{removeError}</p>}

      <ButtonLarge onClick={onArchive} disabled={archiving}>
        {archiving ? "Archiving…" : "Archive Study Room"}
      </ButtonLarge>
      {archiveError && <p role="alert">{archiveError}</p>}
    </Modal>
  );
}

export function StudyRoomsBox({ onClose }: StudyRoomsBoxProps) {
  const { joining, joinError, joinRoom } = useStudyRoomSession();
  const newRoomNameFieldId = useId();

  // `selfLoaded` gates the signed-out gate below so it only renders once sign-in status is
  // actually known.
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [selfLoaded, setSelfLoaded] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);

  const [rooms, setRooms] = useState<StudyRoom[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newRoomName, setNewRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Single-selection room list (rather than each room's own per-item Join button).
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  // Archiving is an owner-only action - archivingId tracks in-flight-per-room the same way
  // `joining` (on the shared study-room session) does, so archiving one room's button doesn't
  // disable every other room's own Archive button too.
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // At most one room's "Manage access" section is expanded at a time.
  const [manageAccessRoomId, setManageAccessRoomId] = useState<string | null>(null);

  // Pre-join camera/mic checkboxes, default both true. Read once by handleJoinSelectedRoom
  // below to build joinRoom()'s `options` param.
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

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

  // Registers with the Header's shared Refresh button instead of rendering its own.
  useRegisterRefresh(loadRooms);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Archives a room this user owns - removed from every user's STUDY_ROOM_LIST
  // (listRooms()'s .is("archived_at", null) filter) immediately, so this optimistically drops it
  // from the local `rooms` list on success rather than waiting on a full loadRooms() re-fetch.
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
        setSelectedRoomId((prev) => (prev === room.id ? null : prev));
      })
      .catch((err) => {
        console.error("Failed to archive study room", err);
        setArchiveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setArchivingId(null));
  }

  // Joins whichever room is currently selected via the shared study-room session's joinRoom().
  // joinRoom() never rejects (every failure path is caught internally and surfaced via the
  // session's own joinError state), so this is a safe fire-and-forget from a UI handler, not a
  // bare unhandled-rejection risk.
  function handleJoinSelectedRoom() {
    const room = (rooms ?? []).find((r) => r.id === selectedRoomId);
    if (!room) return;
    void joinRoom(room, { camera: cameraOn, microphone: micOn });
  }

  // Signed out, there's nothing this box can show - creating/joining/listing rooms all require
  // an authenticated user (studyRoomApi.ts's requireUserId()). Gated on `selfLoaded`
  // (not just `selfUserId === null`) so a signed-in user never sees this prompt flash before the
  // AUTH_GET_SESSION round trip resolves, and on `!selfError` so a failed/rejected AUTH_GET_SESSION
  // call falls through to the normal view's own error handling instead of asserting "sign in" when
  // the real answer is "couldn't check."
  if (selfLoaded && selfUserId === null && !selfError) {
    return (
      <div className="study-room-panel">
        <header className="study-room-panel__header">
          <h2>Study Rooms</h2>
          {onClose && (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
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

  return (
    <div className="study-room-panel">
      <header className="study-room-panel__header">
        <h2>Study Rooms</h2>
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </header>

      <section className="study-room-panel__list">
        {loadError && <p role="alert">Could not load rooms: {loadError}</p>}
        {rooms === null && !loadError && <p>Loading…</p>}
        {rooms !== null && rooms.length === 0 && <p className="sp-text-3">No study rooms yet</p>}
        {rooms !== null && rooms.length > 0 && (
          <ul>
            {rooms.map((room) => {
              const selected = selectedRoomId === room.id;
              return (
                <li key={room.id} className="study-room-panel__room">
                  <ButtonSmall
                    colour={selected ? "pink" : "white"}
                    aria-pressed={selected}
                    onClick={() => setSelectedRoomId(room.id)}
                  >
                    {room.name}
                  </ButtonSmall>
                  {room.ownerUserId === selfUserId && (
                    <ButtonIcon
                      icon="options"
                      aria-label={`${room.name} options`}
                      onClick={() => setManageAccessRoomId(room.id)}
                    />
                  )}
                  {room.ownerUserId === selfUserId && manageAccessRoomId === room.id && (
                    <ManageAccessModal
                      roomId={room.id}
                      roomName={room.name}
                      archiving={archivingId === room.id}
                      archiveError={archiveError}
                      onArchive={() => handleArchiveRoom(room)}
                      onClose={() => setManageAccessRoomId(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="study-room-panel__call-options">
        <ButtonLargeIcon
          icon="microphone"
          enabled={micOn}
          onClick={() => setMicOn((prev) => !prev)}
          aria-label={micOn ? "Join with mic off" : "Join with mic on"}
        />
        <ButtonLargeIcon
          icon="camera"
          enabled={cameraOn}
          onClick={() => setCameraOn((prev) => !prev)}
          aria-label={cameraOn ? "Join with camera off" : "Join with camera on"}
        />
        <ButtonLarge
          onClick={handleJoinSelectedRoom}
          disabled={selectedRoomId === null || joining !== null}
        >
          {joining !== null ? "Joining…" : "Join Study Room"}
        </ButtonLarge>
      </div>
      {joinError && <p role="alert">{joinError}</p>}

      <section className="study-room-panel__create">
        <p className="study-room-panel__create-title">Create Study Room</p>
        <div className="study-room-panel__create-row">
          <Input
            id={newRoomNameFieldId}
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            placeholder="Room Name"
            aria-label="Room Name"
            disabled={creating}
          />
          <ButtonBool
            icon="check"
            aria-label={creating ? "Creating room…" : "Create room"}
            onClick={handleCreateRoom}
            disabled={creating || !newRoomName.trim()}
          />
        </div>
        {createError && <p role="alert">Could not create room: {createError}</p>}
      </section>
    </div>
  );
}
