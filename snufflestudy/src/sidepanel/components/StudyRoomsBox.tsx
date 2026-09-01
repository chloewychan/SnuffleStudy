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

// v4.1 Task 7: the Study tab's list/create/manage-access box - StudyRoomPanel.tsx's entire
// "not joined" branch, moved here unchanged in behavior except: (1) room list items are now
// click-to-select (single selection) instead of each carrying its own Join button - one "Join
// study room" button below the list joins whichever room is currently selected, via
// useStudyRoomSession().joinRoom(); (2) "Archive Study Room" moves inside the ManageAccessModal
// popup (design-specs/frames/popup-study-room.json), opened via each owned room's own "options"
// icon rather than an inline expand/collapse toggle.
// The joined-room view that used to live in this same component is now StudyRoomFooter.tsx, a
// persistent app-shell footer (AppFooter.tsx) that survives a tab switch - this box only ever
// shows the room list/create/manage-access UI, never a joined room.

interface StudyRoomsBoxProps {
  // Mirrors StudyRoomPanel.tsx's own optional onClose (v3.4 Task 4 "no dead button" precedent) -
  // no current caller passes one (StudyTab.tsx mounts this with nowhere to close to), kept
  // optional rather than removed outright for the same reason that precedent was set: a future
  // caller with somewhere real to close to can still use it, and omitting it here means no dead
  // button renders instead of a fake no-op one.
  onClose?: () => void;
}

// design-specs/frames/popup-study-room.json - a modal, not the inline expand-in-place section
// this used to be. Remove-only per its own spec (a trash icon per already-invited friend, no
// "Invite" affordance): inviting now happens exclusively from the Friends tab's own "Add to Room"
// bulk action (FriendsBox.tsx), which already sends the exact same STUDY_ROOM_INVITEE_ADD message
// this component used to send itself for the "not yet invited" half of its old toggle list - that
// half is dropped entirely, not duplicated.
//
// v4.1 Task 7: also owns rendering "Archive Study Room" (moved in from the parent's room <li> -
// scope doc: "Move 'Archive this room' inside Manage access, alongside the friend-invite list").
// Archiving itself (the STUDY_ROOM_ARCHIVE call, the archivingId/archiveError state) still lives in
// the parent (StudyRoomsBox) - only one room's modal is ever open at a time (the existing
// single-expanded-id pattern), so a single shared archiveError is unambiguous here exactly as it
// was before this task.
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

  // v3.3 Task 8: resolves each invitee's userId to their human_name (falling back to the raw id
  // when no profile/name exists) - see shared/ui/useDisplayNames.ts.
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

  // v3.2 Task 2: this box has no auth check at all before this task - mirrors
  // FriendGroupPanel.tsx's loadFriends() auth-check half (AUTH_GET_SESSION -> selfUserId).
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

  // v4.1 Task 7: single-selection room list (replaces each room's own per-item Join button).
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  // v3.3 Task 6: archiving is an owner-only action - archivingId tracks in-flight-per-room the
  // same way `joining` (now on the shared study-room session) does, so archiving one room's
  // button doesn't disable every other room's own Archive button too.
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // v3.3 Task 13: at most one room's "Manage access" section is expanded at a time.
  const [manageAccessRoomId, setManageAccessRoomId] = useState<string | null>(null);

  // v3.3 Task 9: pre-join camera/mic checkboxes - default both true, preserving the pre-Task-9
  // "always publish both" behavior. Read once by handleJoinSelectedRoom below to build
  // joinRoom()'s `options` param.
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

  // v4.1 Task 2: replaces this box's own Refresh button - the Header's one Refresh button now
  // re-runs this fetch (among every other currently-mounted panel's own).
  useRegisterRefresh(loadRooms);

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

  // v3.3 Task 6: archives a room this user owns - removed from every user's STUDY_ROOM_LIST
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

  // v4.1 Task 7: replaces each room's own Join button - joins whichever room is currently
  // selected via the shared study-room session's joinRoom(). joinRoom() never rejects (every
  // failure path is caught internally and surfaced via the session's own joinError state), so this
  // is a safe fire-and-forget from a UI handler, not a bare unhandled-rejection risk.
  function handleJoinSelectedRoom() {
    const room = (rooms ?? []).find((r) => r.id === selectedRoomId);
    if (!room) return;
    void joinRoom(room, { camera: cameraOn, microphone: micOn });
  }

  // v3.2 Task 2: signed out, there's nothing this box can show - creating/joining/listing rooms
  // all require an authenticated user (studyRoomApi.ts's requireUserId()). Gated on `selfLoaded`
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
        {rooms !== null && rooms.length === 0 && <p>No study rooms yet — create one to get started.</p>}
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
        <h3>Create Study Room</h3>
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
