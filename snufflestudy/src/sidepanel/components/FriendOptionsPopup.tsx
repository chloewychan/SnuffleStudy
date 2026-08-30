import type {
  FriendshipSettings,
  FriendshipSettingsPatch,
} from "../../infrastructure/backend/friendshipSettingsApi";
import { FriendSettingsFields } from "../../options/pages/FriendsPage";
import styles from "../styles/frontend-backup/pages/popups/FriendDetailsPopup.module.css";

// v4.2 Task 9: replaces FriendsBox.tsx's old inline openOptionsForFriendId-driven expansion with a
// standalone component built from frontend-backup's FriendDetailsPopup.tsx markup, following the
// exact same routed-page-becomes-a-real-modal convention Task 5's StudyRoomAccessPopup established
// (StudyRoomPopup.module.css's .overlayBackdrop/role="dialog"/close-button/backdrop-click pattern) -
// this codebase's second modal, deliberately reusing the first one's shape rather than inventing a
// second convention.
//
// Decision 2 (settled, not overridable): the design shows all eight of the pre-v4.1 checkbox
// labels (it was built before FriendSettingsFields' own eighth checkbox was dropped - see that
// file's own comment for which one and why). This component renders the ACTUAL, current
// FriendSettingsFields component - the same seven-field render loop FriendsPage.tsx (Options tab)
// already uses - instead of re-deriving the design's eight-item list field-by-field. Reusing the
// real component is what makes dropping the eighth field automatic: there is no eighth field to
// drop by hand, and no way for this popup to accidentally grow that checkbox back, since the
// settings-patch type it binds against has no key left for one.
//
// FriendSettingsFields itself needed a light touch-up (v4.2 Task 9, see FriendsPage.tsx's own
// comment) - an optional `classNames` prop so its checkboxes/remove-button can pick up this
// popup's own CSS Module classes instead of rendering completely unstyled (which is what
// FriendsPage.tsx's own out-of-scope, undesigned Options-tab view still does, and continues to do
// unchanged since it never passes `classNames`).
interface FriendOptionsPopupProps {
  friendId: string;
  // frontend-backup's own H1 slot ("E.g., Friend") is clearly meant to show the specific friend's
  // name - FriendsBox.tsx already has a useDisplayNames() resolver on hand, so threading the
  // resolved name through is a low-risk, design-faithful addition, mirroring
  // StudyRoomAccessPopup's identical `roomName` prop (v4.2 Task 5).
  friendName: string;
  settings: FriendshipSettings | undefined;
  settingsError: string | null;
  savingKey: string | null;
  saveError: string | null;
  onToggle: (friendId: string, field: keyof FriendshipSettingsPatch, checked: boolean) => void;
  onRemove: (friendId: string) => void;
  removing: boolean;
  removeError: string | null;
  // A modal needs a way to be dismissed - wired to both the backdrop click and an explicit close
  // icon, same as StudyRoomAccessPopup's identical `onClose` prop.
  onClose: () => void;
}

export function FriendOptionsPopup({
  friendId,
  friendName,
  settings,
  settingsError,
  savingKey,
  saveError,
  onToggle,
  onRemove,
  removing,
  removeError,
  onClose,
}: FriendOptionsPopupProps) {
  return (
    <div className={styles.overlayBackdrop} onClick={onClose}>
      <div
        className={styles.friendDetailsPopup}
        role="dialog"
        aria-modal="true"
        aria-label={`Options for ${friendName}`}
        // Stops a click inside the card from bubbling to the backdrop's onClose handler - the
        // backdrop-click-to-dismiss behavior should only fire when the backdrop itself (outside
        // the card) is clicked.
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.friendDetails}>
          <div className={styles.popupHeader}>
            <h1 className={styles.egFriend}>{friendName}</h1>
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

          <div className={styles.trackingOptions}>
            <h3 className={styles.tracking}>Tracking</h3>
            {settingsError && (
              <p role="alert">Couldn't load friend settings: {settingsError}.</p>
            )}
            <FriendSettingsFields
              friendId={friendId}
              settings={settings}
              savingKey={savingKey}
              onToggle={onToggle}
              onRemove={onRemove}
              removing={removing}
              classNames={{
                row: styles.listItem,
                checkbox: styles.buttonListIcon,
                labelText: styles.egFriend,
                removeButton: styles.buttonLarge,
                removeButtonText: styles.button,
              }}
            />
            {saveError && <p role="alert">Couldn't save: {saveError}. Please try again.</p>}
            {removeError && (
              <p role="alert">Couldn't remove this friend: {removeError}. Please try again.</p>
            )}
          </div>
        </header>
      </div>
    </div>
  );
}
