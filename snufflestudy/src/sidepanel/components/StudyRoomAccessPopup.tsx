import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { RoomInvitee } from "../../domain/rooms/studyRoom";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import IconButton from "../ui/IconButton";
import styles from "../styles/frontend-backup/pages/popups/StudyRoomPopup.module.css";

// v4.2 Task 5: replaces StudyRoomsBox.tsx's old inline ManageAccessSection (deleted this task)
// with a standalone component built from frontend-backup's StudyRoomPopup.tsx markup. Decision 3
// (settled): this is a real behavior narrowing, not just a re-skin - it shows only currently-
// invited friends, each with a remove-only action (STUDY_ROOM_INVITEE_REMOVE). There is no
// add-toggle and no way to grant access from here at all - granting access is the Friends box's
// job (STUDY_ROOM_INVITEE_ADD, already built in v4.1 Task 9), not this popup's.
//
// frontend-backup renders this as its own routed "page" (no header/nav of its own, since Decision
// 1 already established those render once at the shell level) - this app has no routing, so it's
// mounted as a fixed-position modal overlay instead (StudyRoomsBox.tsx's judgment call, documented
// in the v4.2 Task 5 report: no existing overlay/modal precedent elsewhere in this codebase's
// sidepanel components, so this is the first one, following the plan's own implied default).
interface StudyRoomAccessPopupProps {
  roomId: string;
  // Addition beyond the plan's literal 4-prop list (roomId/onArchive/archiving/archiveError):
  // frontend-backup's own H1 slot ("E.g., Study room") is clearly meant to show the specific
  // room's name, the same way "E.g., Friend One" is meant to show a specific friend's name below
  // it - StudyRoomsBox.tsx already has the room object on hand (it's rendering this popup from
  // its own `rooms` list), so threading the name through is a low-risk, design-faithful addition.
  roomName: string;
  onArchive: () => void;
  archiving: boolean;
  archiveError: string | null;
  // Addition beyond the plan's literal prop list: a modal needs a way to be dismissed. Backing
  // state (`openAccessPopupForRoomId`) lives in StudyRoomsBox.tsx per the plan's own Interfaces
  // block; this callback is how that parent state gets cleared, wired to both the backdrop click
  // and an explicit close icon (the plan's own "dismissible by an explicit close action or
  // backdrop click" instruction).
  onClose: () => void;
}

export function StudyRoomAccessPopup({
  roomId,
  roomName,
  onArchive,
  archiving,
  archiveError,
  onClose,
}: StudyRoomAccessPopupProps) {
  const [invitees, setInvitees] = useState<RoomInvitee[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // v3.3 Task 8 convention (see useDisplayNames.ts) - resolves each invitee's userId to their
  // human_name, falling back to the raw id when no profile/name exists.
  const displayName = useDisplayNames((invitees ?? []).map((invitee) => invitee.userId));

  useEffect(() => {
    let cancelled = false;
    setInvitees(null);
    setLoadError(null);

    sendMessage<{ ok: boolean; invitees?: RoomInvitee[]; error?: string }>({
      type: "STUDY_ROOM_INVITEES_LIST",
      payload: { roomId },
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.invitees) {
          setLoadError(res.error ?? "Could not load who's currently invited.");
          return;
        }
        setInvitees(res.invitees);
      })
      .catch((err) => {
        console.error("Failed to load room invitees", err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  function handleRemove(userId: string) {
    setRemovingUserId(userId);
    setRemoveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "STUDY_ROOM_INVITEE_REMOVE",
      payload: { roomId, userId },
    })
      .then((res) => {
        if (!res.ok) {
          setRemoveError(res.error ?? "Could not remove this invitee.");
          return;
        }
        setInvitees((prev) => (prev ?? []).filter((invitee) => invitee.userId !== userId));
      })
      .catch((err) => {
        console.error("Failed to remove a room invitee", err);
        setRemoveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setRemovingUserId(null));
  }

  return (
    <div className={styles.overlayBackdrop} onClick={onClose}>
      <div
        className={styles.studyRoomPopup}
        role="dialog"
        aria-modal="true"
        aria-label={`Manage access for ${roomName}`}
        // Stops a click inside the card from bubbling to the backdrop's onClose handler - the
        // backdrop-click-to-dismiss behavior should only fire when the backdrop itself (outside
        // the card) is clicked.
        onClick={(e) => e.stopPropagation()}
      >
        <section className={styles.mainContainer}>
          <div className={styles.popupHeader}>
            <h1 className={styles.egStudyRoom}>{roomName}</h1>
            <button
              type="button"
              className={styles.closeButtonReset}
              onClick={onClose}
              aria-label="Close"
            >
              <img
                className={styles.buttonIcon}
                alt=""
                src={chrome.runtime.getURL("sidepanel/assets/icon-close.svg")}
              />
            </button>
          </div>

          {loadError && <p role="alert">Couldn't load invitees: {loadError}.</p>}
          {invitees === null && !loadError && <p>Loading…</p>}
          {invitees !== null && invitees.length === 0 && (
            <p>No one is currently invited to this room.</p>
          )}

          {invitees !== null && invitees.length > 0 && (
            <div className={styles.exampleListItems}>
              {invitees.map((invitee) => (
                <div className={styles.egFriendOneParent} key={invitee.userId}>
                  <h3 className={styles.egFriendOne}>{displayName(invitee.userId)}</h3>
                  <IconButton
                    icon={chrome.runtime.getURL("sidepanel/assets/icon-trash.svg")}
                    label="Remove friend from room"
                    onClick={() => handleRemove(invitee.userId)}
                    disabled={removingUserId === invitee.userId}
                  />
                </div>
              ))}
            </div>
          )}
          {removeError && <p role="alert">{removeError}</p>}

          <button
            type="button"
            className={styles.buttonLarge}
            onClick={onArchive}
            disabled={archiving}
          >
            <div className={styles.button}>{archiving ? "Archiving…" : "Archive Study Room"}</div>
          </button>
          {archiveError && <p role="alert">{archiveError}</p>}
        </section>
      </div>
    </div>
  );
}
