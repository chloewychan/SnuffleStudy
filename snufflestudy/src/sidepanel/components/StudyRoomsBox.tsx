import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { StudyRoom } from "../../domain/rooms/studyRoom";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";
import { StudyRoomAccessPopup } from "./StudyRoomAccessPopup";
import styles from "../styles/frontend-backup/components/study/StudyRoomsPanel.module.css";
import inputStyles from "../styles/frontend-backup/components/inputs/InputCreateStudyRoom.module.css";

// v4.1 Task 7: the Study tab's list/create/manage-access box - StudyRoomPanel.tsx's entire
// "not joined" branch, moved here unchanged in behavior except: (1) room list items are now
// click-to-select (single selection) instead of each carrying its own Join button - one "Join
// study room" button below the list joins whichever room is currently selected, via
// useStudyRoomSession().joinRoom(); (2) "Archive this room" moves inside the room-access popup's
// own render, alongside the friend-invite list, instead of sitting beside the "Manage access"
// toggle. The joined-room view that used to live in this same component is now StudyRoomFooter.tsx,
// a persistent app-shell footer (AppFooter.tsx) that survives a tab switch - this box only ever
// shows the room list/create/manage-access UI, never a joined room.
//
// v4.2 Task 5: re-skinned as frontend-backup's StudyRoomsPanel.tsx design. Per Decision 4
// (settled, not overridable): the design's second InputCreateStudyRoom instance (a
// join-by-code style heading/placeholder pair) is not ported at all - there is no join-by-code
// path anywhere in this app, now or planned; the owner grants access via STUDY_ROOM_INVITEE_ADD
// (Friends box) and that stays the only path in. The one legitimate "join the currently-selected
// room" button below keeps its pre-v4.2 button copy exactly (not the design's own literal label
// for that button), specifically so it can never be confused with - or grepped-together with -
// that removed heading's text. Per Decision 3 (settled): the old inline ManageAccessSection (a
// full add/remove toggle against every friend) is replaced by the narrower StudyRoomAccessPopup -
// a real behavior change, not just a re-skin - which shows only currently-invited friends, each
// with a remove-only action. `openAccessPopupForRoomId` replaces the old `manageAccessRoomId`.
interface StudyRoomsBoxProps {
  // Mirrors StudyRoomPanel.tsx's own optional onClose (v3.4 Task 4 "no dead button" precedent) -
  // no current caller passes one (StudyTab.tsx mounts this with nowhere to close to), kept
  // optional rather than removed outright for the same reason that precedent was set: a future
  // caller with somewhere real to close to can still use it, and omitting it here means no dead
  // button renders instead of a fake no-op one. frontend-backup's own StudyRoomsPanel.tsx design
  // has no close affordance of its own (no per-tab close button anywhere in the new design,
  // per Decision 1) - kept as a plain, unstyled button, same treatment Task 4 gave
  // TaskVaultPage.tsx's equally-dead onClose prop.
  onClose?: () => void;
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

  // v4.2 Task 5: replaces the old manageAccessRoomId - at most one room's StudyRoomAccessPopup is
  // open at a time.
  const [openAccessPopupForRoomId, setOpenAccessPopupForRoomId] = useState<string | null>(null);

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
  // v4.2 Task 5: also closes the access popup if it was open for this room (DoD: "Archiving
  // removes the room from the list and closes the popup").
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
        setOpenAccessPopupForRoomId((prev) => (prev === room.id ? null : prev));
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

  const roomForAccessPopup = (rooms ?? []).find((r) => r.id === openAccessPopupForRoomId) ?? null;

  // v3.2 Task 2: signed out, there's nothing this box can show - creating/joining/listing rooms
  // all require an authenticated user (studyRoomApi.ts's requireUserId()). Gated on `selfLoaded`
  // (not just `selfUserId === null`) so a signed-in user never sees this prompt flash before the
  // AUTH_GET_SESSION round trip resolves, and on `!selfError` so a failed/rejected AUTH_GET_SESSION
  // call falls through to the normal view's own error handling instead of asserting "sign in" when
  // the real answer is "couldn't check."
  //
  // v4.2 Task 5: frontend-backup's StudyRoomsPanel.tsx design has no sign-in state of its own (a
  // 100% static design with no auth concept at all) - built fresh using this file's own
  // studyRoomPanel/studySession classes for visual consistency with the signed-in view below,
  // same "no design, build from the same design system" treatment Decision 5 gives
  // RequestUnlockForm.
  if (selfLoaded && selfUserId === null && !selfError) {
    return (
      <section className={styles.studyRoomPanel}>
        <h2 className={styles.studySession}>Study Rooms</h2>
        {selfError && <p role="alert">Couldn't verify sign-in: {selfError}.</p>}
        <p>Sign in to create or join a study room with your friends.</p>
        <SignInForm
          onSignedIn={(session) => {
            setSelfUserId(session.user.id);
            loadRooms();
          }}
        />
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </section>
    );
  }

  return (
    <section className={styles.studyRoomPanel}>
      <h2 className={styles.studySession}>Study Rooms</h2>

      <div className={styles.roomList}>
        <h3 className={styles.goal}>Rooms among your friends</h3>
        {loadError && <p role="alert">Could not load rooms: {loadError}</p>}
        {rooms === null && !loadError && <p>Loading…</p>}
        {rooms !== null && rooms.length === 0 && (
          <p>No study rooms yet — create one to get started.</p>
        )}
        {rooms !== null &&
          rooms.length > 0 &&
          rooms.map((room) => (
            <div className={styles.exampleListItem} key={room.id}>
              <button
                type="button"
                className={styles.buttonSmall}
                onClick={() => setSelectedRoomId(room.id)}
                aria-pressed={selectedRoomId === room.id}
              >
                <div className={styles.button6}>{room.name}</div>
              </button>
              {room.ownerUserId === selfUserId && (
                <button
                  type="button"
                  className={styles.buttonIconReset}
                  onClick={() => setOpenAccessPopupForRoomId(room.id)}
                  aria-label={`Manage access for ${room.name}`}
                >
                  <img
                    className={styles.buttonIcon}
                    alt=""
                    src={chrome.runtime.getURL("sidepanel/assets/button-options.svg")}
                  />
                </button>
              )}
            </div>
          ))}
      </div>

      <div className={styles.callOptionPanel}>
        <button
          type="button"
          className={styles.buttonLargeIconReset}
          onClick={() => setMicOn((v) => !v)}
          aria-pressed={micOn}
          aria-label="Microphone"
        >
          <img
            className={styles.buttonLargeIcon}
            loading="lazy"
            alt=""
            src={chrome.runtime.getURL(
              micOn ? "sidepanel/assets/button-mic-on.svg" : "sidepanel/assets/button-mic-off@2x.png"
            )}
          />
        </button>
        <button
          type="button"
          className={styles.buttonLargeIconReset}
          onClick={() => setCameraOn((v) => !v)}
          aria-pressed={cameraOn}
          aria-label="Camera"
        >
          <img
            className={styles.buttonLargeIcon}
            loading="lazy"
            alt=""
            src={chrome.runtime.getURL(
              cameraOn
                ? "sidepanel/assets/button-camera-on.svg"
                : "sidepanel/assets/button-camera-off@2x.png"
            )}
          />
        </button>
        <button
          type="button"
          className={styles.buttonLarge3}
          onClick={handleJoinSelectedRoom}
          disabled={selectedRoomId === null || joining !== null}
        >
          {/* Kept as the pre-v4.2 button copy ("Join study room", not the design's own literal
              label for this button) - see this file's header comment for why: it must never
              collide, textually, with the removed join-by-code heading's own copy. */}
          <h3 className={styles.button}>{joining !== null ? "Joining…" : "Join study room"}</h3>
        </button>
      </div>
      {joinError && <p role="alert">{joinError}</p>}

      <div className={inputStyles.inputCreateStudyRoom}>
        <label className={inputStyles.createStudyRoom} htmlFor="new-room-name">
          Create Study Room
        </label>
        <div className={inputStyles.frame}>
          <div className={inputStyles.input}>
            <input
              id="new-room-name"
              className={inputStyles.textbox}
              type="text"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="E.g., Room name"
              disabled={creating}
            />
          </div>
          <button
            type="button"
            className={inputStyles.buttonBoolIconReset}
            onClick={handleCreateRoom}
            disabled={creating || !newRoomName.trim()}
            aria-label={creating ? "Creating…" : "Create study room"}
          >
            <img
              className={inputStyles.buttonBoolIcon}
              alt=""
              src={chrome.runtime.getURL("sidepanel/assets/button-check.svg")}
            />
          </button>
        </div>
        {createError && <p role="alert">Could not create room: {createError}</p>}
      </div>

      {roomForAccessPopup && (
        <StudyRoomAccessPopup
          roomId={roomForAccessPopup.id}
          roomName={roomForAccessPopup.name}
          archiving={archivingId === roomForAccessPopup.id}
          archiveError={archiveError}
          onArchive={() => handleArchiveRoom(roomForAccessPopup)}
          onClose={() => setOpenAccessPopupForRoomId(null)}
        />
      )}
    </section>
  );
}
