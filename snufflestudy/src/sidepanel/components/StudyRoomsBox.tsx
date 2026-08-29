import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { StudyRoom, RoomInvitee } from "../../domain/rooms/studyRoom";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";

// v4.1 Task 7: the Study tab's list/create/manage-access box - StudyRoomPanel.tsx's entire
// "not joined" branch, moved here unchanged in behavior except: (1) room list items are now
// click-to-select (single selection) instead of each carrying its own Join button - one "Join
// study room" button below the list joins whichever room is currently selected, via
// useStudyRoomSession().joinRoom(); (2) "Archive this room" moves inside ManageAccessSection's own
// render, alongside the friend-invite list, instead of sitting beside the "Manage access" toggle.
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

// v3.3 Task 13: the owner-only "Manage access" section for one room - lists the owner's friends
// with an add/remove toggle against each one, backed by STUDY_ROOM_INVITEE_ADD/REMOVE/
// STUDY_ROOM_INVITEES_LIST. A separate component (not inlined into the room-list <li> below) so
// its own friend/invitee fetch only ever runs for the one room currently expanded, not once per
// owned room on every render.
//
// v4.1 Task 7: also owns rendering "Archive this room" now (moved in from the parent's room <li> -
// scope doc: "Move 'Archive this room' inside Manage access, alongside the friend-invite list").
// Archiving itself (the STUDY_ROOM_ARCHIVE call, the archivingId/archiveError state) still lives in
// the parent (StudyRoomsBox) - only one room's ManageAccessSection is ever expanded at a time (the
// existing single-expanded-id pattern), so a single shared archiveError is unambiguous here exactly
// as it was when rendered beside the list before this task.
function ManageAccessSection({
  roomId,
  archiving,
  archiveError,
  onArchive,
}: {
  roomId: string;
  archiving: boolean;
  archiveError: string | null;
  onArchive: () => void;
}) {
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

    sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({
      type: "FRIENDS_LIST",
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setFriendsError(res.error ?? "Could not load your friends.");
          return;
        }
        setFriendIds(res.friendIds ?? []);
      })
      .catch((err) => {
        console.error("Failed to load friends for the invite picker", err);
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

      <button type="button" onClick={onArchive} disabled={archiving}>
        {archiving ? "Archiving…" : "Archive this room"}
      </button>
      {archiveError && <p role="alert">{archiveError}</p>}
    </div>
  );
}

export function StudyRoomsBox({ onClose }: StudyRoomsBoxProps) {
  const { joining, joinError, joinRoom } = useStudyRoomSession();

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
              <li
                key={room.id}
                onClick={() => setSelectedRoomId(room.id)}
                aria-selected={selectedRoomId === room.id}
                className={
                  selectedRoomId === room.id
                    ? "study-room-panel__room study-room-panel__room--selected"
                    : "study-room-panel__room"
                }
              >
                <span>{room.name}</span>
                {room.ownerUserId === selfUserId && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setManageAccessRoomId((prev) => (prev === room.id ? null : room.id));
                    }}
                  >
                    {manageAccessRoomId === room.id ? "Hide manage access" : "Manage access"}
                  </button>
                )}
                {room.ownerUserId === selfUserId && manageAccessRoomId === room.id && (
                  <ManageAccessSection
                    roomId={room.id}
                    archiving={archivingId === room.id}
                    archiveError={archiveError}
                    onArchive={() => handleArchiveRoom(room)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button
        type="button"
        onClick={handleJoinSelectedRoom}
        disabled={selectedRoomId === null || joining !== null}
      >
        {joining !== null ? "Joining…" : "Join study room"}
      </button>
      {joinError && <p role="alert">{joinError}</p>}
    </div>
  );
}
