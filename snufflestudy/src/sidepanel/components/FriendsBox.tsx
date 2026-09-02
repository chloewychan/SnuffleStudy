import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { InviteCode } from "../../infrastructure/backend/friendshipApi";
import type {
  FriendshipSettings,
  FriendshipSettingsPatch,
} from "../../infrastructure/backend/friendshipSettingsApi";
import type { StudyRoom } from "../../domain/rooms/studyRoom";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useNudgeVaultItems } from "../nudgeVault/useNudgeVaultItems";
import { TOGGLE_FIELDS } from "../../options/pages/FriendsPage";
import { Modal } from "./ui/Modal";
import { ButtonList } from "./ui/ButtonList";
import { ButtonIcon } from "./ui/ButtonIcon";
import { ButtonBool } from "./ui/ButtonBool";
import { ButtonLarge } from "./ui/ButtonLarge";
import { Input } from "./ui/Input";

// design-specs/frames/popup-friend.json's "Tracking" list groups the first 3 fields (nudge
// send/receive, distraction attempts) in pink and the last 4 (the v4.1 Task 10 sharing fields) in
// beige - the daily-digest checkbox the spec still shows is NOT included here: it was
// deliberately dropped from TOGGLE_FIELDS in v4.1 Task 9 (see that file's own comment), the same
// "confirmed not to exist in the product, don't rebuild it" precedent as the old plan's "Enter
// Office Building" button.
const TRACKING_FIELD_COLOUR: ("pink" | "beige")[] = ["pink", "pink", "pink", "beige", "beige", "beige", "beige"];

function FriendOptionsModal({
  friendId,
  name,
  settings,
  savingKey,
  onToggle,
  onRemove,
  removing,
  onClose,
}: {
  friendId: string;
  name: string;
  settings: FriendshipSettings | undefined;
  savingKey: string | null;
  onToggle: (friendId: string, field: keyof FriendshipSettingsPatch, checked: boolean) => void;
  onRemove: (friendId: string) => void;
  removing: boolean;
  onClose: () => void;
}) {
  return (
    <Modal title={name} onClose={onClose}>
      {!settings && (
        <p>
          No settings row yet for this friend — you may not have added each other as friends yet,
          or they joined before this feature existed.
        </p>
      )}
      {settings && (
        <>
          <h3 className="friend-options-modal__title">Tracking</h3>
          <ul className="friend-options-modal__list">
            {TOGGLE_FIELDS.map(({ key, label }, i) => {
              const checked = Boolean(settings[key]);
              const fieldKey = `${friendId}:${key}`;
              const saving = savingKey === fieldKey;
              return (
                <li key={fieldKey} className={saving ? "friend-options-modal__item--saving" : undefined}>
                  <ButtonList
                    shape="square"
                    colour={TRACKING_FIELD_COLOUR[i]}
                    role="checkbox"
                    selected={checked}
                    onClick={saving ? undefined : () => onToggle(friendId, key, !checked)}
                    aria-label={label}
                  />
                  <span>{label}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ButtonLarge onClick={() => onRemove(friendId)} disabled={removing}>
        {removing ? "Removing…" : "Remove Friend"}
      </ButtonLarge>
    </Modal>
  );
}

// v4.1 Task 9: replaces FriendGroupPanel.tsx's friend-picker/nudge-send half and the old
// Settings -> Account "Your friends"/"Add a friend"/"Invite a friend" sections (scope doc's
// "Friends Tab") with one multi-select Friends box:
// - a checklist of friends, each with an "Options" button opening the exact same
//   FriendSettingsFields component FriendsPage.tsx now exports (see that file's own comment) -
//   one implementation shared by this popover and the Options page's standalone Friends view;
// - a bulk Nudge action (Decision 7/8: one existing per-target message per selected friend, fired
//   in a loop - same shape as StudyRoomFooter.tsx's identical per-selected-participant Nudge
//   action, and the same useNudgeVaultItems() hook that footer now also uses);
// - a bulk Add-to-room action (STUDY_ROOM_INVITEE_ADD once per selected friend, the same message
//   ManageAccessSection already uses one at a time);
// - "Add a friend"/"Invite a friend", moved verbatim from AccountPage.tsx (FRIEND_REDEEM_CODE/
//   FRIEND_INVITE_GENERATE_CODE - unchanged messages, unchanged logic).
export function FriendsBox() {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [selfLoaded, setSelfLoaded] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);

  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);

  const [settingsByFriend, setSettingsByFriend] = useState<Record<string, FriendshipSettings>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(new Set());
  const [openOptionsForFriendId, setOpenOptionsForFriendId] = useState<string | null>(null);

  // Mirrors FriendsPage.tsx's own savingKey/saveError shape exactly - see that file's comment on
  // why it's keyed `${friendId}:${field}` (only that one checkbox disables, not the whole popover).
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const displayName = useDisplayNames(friendIds ?? []);

  const {
    items: vaultItems,
    loading: vaultLoading,
    error: vaultError,
    refresh: refreshVaultItems,
  } = useNudgeVaultItems();
  const [vaultNudgeKey, setVaultNudgeKey] = useState("");
  const [nudging, setNudging] = useState(false);
  const [nudgeError, setNudgeError] = useState<string | null>(null);

  const [rooms, setRooms] = useState<StudyRoom[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomToAddTo, setRoomToAddTo] = useState("");
  const [addingToRoom, setAddingToRoom] = useState(false);
  const [addToRoomError, setAddToRoomError] = useState<string | null>(null);

  const [inviteCode, setInviteCode] = useState<InviteCode | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);

  // Mirrors StudyRoomsBox.tsx's own loadSelf() shape exactly (same AUTH_GET_SESSION response
  // type, same ok/error handling) - this box needs its own sign-in gate, since (unlike
  // FriendGroupPanel.tsx's constituent sections, which each guarded their own friend-picker) it's
  // the sole home for "Add a friend"/"Invite a friend" now.
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
        console.error("Failed to load current user for the Friends box", err);
        setSelfError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSelfLoaded(true));
  }

  function loadFriends() {
    setFriendsError(null);
    sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({ type: "FRIENDS_LIST" })
      .then((res) => {
        if (!res.ok) {
          setFriendsError(res.error ?? "Could not load friends.");
          return;
        }
        setFriendIds(res.friendIds ?? []);
      })
      .catch((err) => {
        console.error("Failed to load friends", err);
        setFriendsError(err instanceof Error ? err.message : String(err));
      });
  }

  // Mirrors FriendsPage.tsx's own FRIENDSHIP_SETTINGS_LIST fetch exactly - loaded up front for
  // every friend, so opening any one friend's Options popover shows their settings instantly
  // rather than firing a per-friend fetch on open.
  function loadFriendshipSettings() {
    setSettingsError(null);
    sendMessage<{ ok: boolean; settings?: FriendshipSettings[]; error?: string }>({
      type: "FRIENDSHIP_SETTINGS_LIST",
    })
      .then((res) => {
        if (!res.ok) {
          setSettingsError(res.error ?? "Could not load friend settings.");
          return;
        }
        const byFriend: Record<string, FriendshipSettings> = {};
        for (const row of res.settings ?? []) {
          byFriend[row.friendUserId] = row;
        }
        setSettingsByFriend(byFriend);
      })
      .catch((err) => {
        console.error("Failed to load friendship settings", err);
        setSettingsError(err instanceof Error ? err.message : String(err));
      });
  }

  function loadRooms() {
    setRoomsError(null);
    sendMessage<{ ok: boolean; rooms?: StudyRoom[]; error?: string }>({ type: "STUDY_ROOM_LIST" })
      .then((res) => {
        if (!res.ok || !res.rooms) {
          setRoomsError(res.error ?? "Could not load study rooms.");
          return;
        }
        setRooms(res.rooms);
      })
      .catch((err) => {
        console.error("Failed to load study rooms for the Friends box", err);
        setRoomsError(err instanceof Error ? err.message : String(err));
      });
  }

  useEffect(() => {
    loadSelf();
    loadFriends();
    loadFriendshipSettings();
    loadRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v4.1 Task 2: replaces every constituent section's own Refresh button with one registration -
  // the Header's one Refresh button re-runs every fetch this box owns (friends, their settings,
  // rooms) plus the shared vault-items fetch.
  function refreshOwnFetches() {
    loadFriends();
    loadFriendshipSettings();
    loadRooms();
    refreshVaultItems();
  }
  useRegisterRefresh(refreshOwnFetches);

  function toggleFriendSelected(friendId: string) {
    setSelectedFriendIds((prev) => {
      const next = new Set(prev);
      if (next.has(friendId)) {
        next.delete(friendId);
      } else {
        next.add(friendId);
      }
      return next;
    });
  }

  // Mirrors FriendsPage.tsx's own handleToggle exactly (same optimistic-update-then-rollback
  // convention).
  function handleToggleSetting(friendId: string, field: keyof FriendshipSettingsPatch, checked: boolean) {
    const key = `${friendId}:${field}`;
    setSavingKey(key);
    setSaveError(null);
    const previous = settingsByFriend[friendId];
    if (previous) {
      setSettingsByFriend((prev) => ({ ...prev, [friendId]: { ...previous, [field]: checked } }));
    }
    sendMessage<{ ok: boolean; settings?: FriendshipSettings; error?: string }>({
      type: "FRIENDSHIP_SETTINGS_UPDATE",
      payload: { friendUserId: friendId, patch: { [field]: checked } },
    })
      .then((res) => {
        if (!res.ok || !res.settings) {
          setSaveError(res.error ?? "Could not save that change.");
          if (previous) setSettingsByFriend((prev) => ({ ...prev, [friendId]: previous }));
          return;
        }
        setSettingsByFriend((prev) => ({ ...prev, [friendId]: res.settings! }));
      })
      .catch((err) => {
        console.error("Failed to update friendship settings", err);
        setSaveError(err instanceof Error ? err.message : String(err));
        if (previous) setSettingsByFriend((prev) => ({ ...prev, [friendId]: previous }));
      })
      .finally(() => setSavingKey(null));
  }

  // Mirrors AccountPage.tsx's own handleRemoveFriend exactly (either party can unilaterally end
  // the friendship) - also drops the removed id out of any current selection and closes its
  // Options popover if it happened to be open.
  function handleRemoveFriend(friendId: string) {
    setRemovingId(friendId);
    setRemoveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "FRIEND_REMOVE",
      payload: { friendUserId: friendId },
    })
      .then((res) => {
        if (!res.ok) {
          setRemoveError(res.error ?? "Could not remove this friend.");
          return;
        }
        setFriendIds((prev) => (prev ? prev.filter((id) => id !== friendId) : prev));
        setSelectedFriendIds((prev) => {
          if (!prev.has(friendId)) return prev;
          const next = new Set(prev);
          next.delete(friendId);
          return next;
        });
        setOpenOptionsForFriendId((prev) => (prev === friendId ? null : prev));
      })
      .catch((err) => {
        console.error("Failed to remove a friend", err);
        setRemoveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setRemovingId(null));
  }

  // Decision 7/8: one existing per-target message per selected friend, fired in a loop - the same
  // shape as StudyRoomFooter.tsx's identical per-selected-participant Nudge action.
  function handleNudge() {
    if (!vaultNudgeKey || selectedFriendIds.size === 0) return;
    const [kind, id] = vaultNudgeKey.split(":", 2) as ["written" | "audio", string];
    setNudging(true);
    setNudgeError(null);
    const targets = [...selectedFriendIds];

    Promise.all(
      targets.map((friendUserId) => {
        const send =
          kind === "written"
            ? sendMessage<{ ok: boolean; error?: string }>({
                type: "NUDGE_SEND",
                payload: { friendUserId, vaultTextId: id },
              })
            : sendMessage<{ ok: boolean; error?: string }>({
                type: "PRODUCER_TAG_SEND_TO_FRIEND",
                payload: { tagId: id, friendUserId },
              });
        // Each send is caught individually (not left to reject through Promise.all) - standing
        // rule against a bare async call in a UI handler applies equally to a loop of them: one
        // recipient's rejection must not become an unhandled rejection, and must not stop the
        // others in the loop from being attempted.
        return send.catch((err) => {
          console.error("Failed to send a nudge from the Friends box", err);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        });
      })
    )
      .then((results) => {
        const failed = results.find((r) => !r.ok);
        if (failed) {
          setNudgeError(failed.error ?? "Could not send that nudge to everyone selected.");
        }
      })
      .finally(() => {
        setNudging(false);
        setSelectedFriendIds(new Set());
      });
  }

  // Decision 7: one existing STUDY_ROOM_INVITEE_ADD per selected friend, fired in a loop - the
  // same message ManageAccessSection already sends one at a time.
  function handleAddToRoom() {
    if (!roomToAddTo || selectedFriendIds.size === 0) return;
    setAddingToRoom(true);
    setAddToRoomError(null);
    const targets = [...selectedFriendIds];

    Promise.all(
      targets.map((userId) =>
        sendMessage<{ ok: boolean; error?: string }>({
          type: "STUDY_ROOM_INVITEE_ADD",
          payload: { roomId: roomToAddTo, userId },
        }).catch((err) => {
          console.error("Failed to add a friend to a study room", err);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        })
      )
    )
      .then((results) => {
        const failed = results.find((r) => !r.ok);
        if (failed) {
          setAddToRoomError(failed.error ?? "Could not add everyone selected to that room.");
        }
      })
      .finally(() => {
        setAddingToRoom(false);
        setSelectedFriendIds(new Set());
      });
  }

  // Moved verbatim from AccountPage.tsx.
  async function handleInviteAFriend() {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await sendMessage<{ ok: boolean; inviteCode?: InviteCode; error?: string }>({
        type: "FRIEND_INVITE_GENERATE_CODE",
      });
      if (!res.ok || !res.inviteCode) {
        setInviteError(res.error ?? "Could not generate an invite code.");
        return;
      }
      setInviteCode(res.inviteCode);
    } catch (err) {
      console.error("Failed to invite a friend", err);
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviteBusy(false);
    }
  }

  // Moved verbatim from AccountPage.tsx.
  async function handleAddFriend(e: React.FormEvent) {
    e.preventDefault();
    setJoinBusy(true);
    setJoinError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "FRIEND_REDEEM_CODE",
        payload: { code: joinCode },
      });
      if (!res.ok) {
        setJoinError(res.error ?? "Could not add your friend with that code.");
        return;
      }
      setJoinCode("");
      loadFriends();
    } catch (err) {
      console.error("Failed to redeem an invite code", err);
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoinBusy(false);
    }
  }

  // Signed out: nothing this box can show - every fetch it owns requires an authenticated user.
  // Mirrors StudyRoomsBox.tsx's identical gate (selfLoaded so a signed-in user's real friend list
  // never flashes a sign-in prompt first; !selfError so a failed AUTH_GET_SESSION call falls
  // through to its own error handling instead).
  if (selfLoaded && selfUserId === null && !selfError) {
    return (
      <div className="friends-box">
        <h2>Friends</h2>
        {selfError && <p role="alert">Couldn't verify sign-in: {selfError}.</p>}
        <div className="friends-box__sign-in">
          <p>Sign in to manage your friends.</p>
          <SignInForm
            onSignedIn={(session) => {
              setSelfUserId(session.user.id);
              loadFriends();
              loadFriendshipSettings();
              loadRooms();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="friends-box">
      <h2>Friends</h2>

      {friendsError && <p role="alert">Couldn't load friends: {friendsError}. Please try again.</p>}
      {friendIds === null && !friendsError && <p>Loading…</p>}
      {friendIds !== null && friendIds.length === 0 && !friendsError && (
        <p>No friends yet — add one below.</p>
      )}
      {friendIds !== null && friendIds.length > 0 && (
        <ul className="friends-box__list">
          {friendIds.map((friendId) => (
            <li key={friendId} className="friends-box__friend">
              <ButtonList
                shape="square"
                colour="white"
                role="checkbox"
                selected={selectedFriendIds.has(friendId)}
                onClick={() => toggleFriendSelected(friendId)}
                aria-label={displayName(friendId)}
              />
              <span className="friends-box__friend-name">{displayName(friendId)}</span>
              <ButtonIcon
                icon="options"
                aria-label={`${displayName(friendId)} options`}
                onClick={() => setOpenOptionsForFriendId(friendId)}
              />
            </li>
          ))}
        </ul>
      )}
      {settingsError && <p role="alert">Couldn't load friend settings: {settingsError}.</p>}
      {saveError && <p role="alert">Couldn't save: {saveError}. Please try again.</p>}
      {removeError && (
        <p role="alert">Couldn't remove this friend: {removeError}. Please try again.</p>
      )}

      {openOptionsForFriendId && (
        <FriendOptionsModal
          friendId={openOptionsForFriendId}
          name={displayName(openOptionsForFriendId)}
          settings={settingsByFriend[openOptionsForFriendId]}
          savingKey={savingKey}
          onToggle={handleToggleSetting}
          onRemove={handleRemoveFriend}
          removing={removingId === openOptionsForFriendId}
          onClose={() => setOpenOptionsForFriendId(null)}
        />
      )}

      <section className="friends-box__nudge">
        {/* No heading here on purpose - the ButtonLarge below already reads "Nudge (N
            selected)", so a separate "Nudge" label directly above it would just repeat itself. */}
        {vaultError && <p role="alert">Couldn't load your Nudge Vault: {vaultError}.</p>}
        {vaultLoading && vaultItems.length === 0 && !vaultError && <p>Loading…</p>}
        {!vaultLoading && vaultItems.length === 0 && !vaultError && (
          <p className="sp-text-3">No saved nudges yet</p>
        )}
        <div className="friends-box__action-row">
          <ButtonLarge
            onClick={handleNudge}
            disabled={nudging || !vaultNudgeKey || selectedFriendIds.size === 0}
          >
            {nudging ? "Sending…" : `Nudge (${selectedFriendIds.size} selected)`}
          </ButtonLarge>
          {vaultItems.length > 0 && (
            <Input
              variant="dropdown"
              aria-label="Nudge Vault item"
              value={vaultNudgeKey}
              onChange={(e) => setVaultNudgeKey(e.target.value)}
            >
              <option value="">Choose a saved nudge</option>
              {vaultItems.map((item) => (
                <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
                  {item.kind === "written"
                    ? item.body
                    : `Audio clip (${Math.round(item.durationMs / 1000)}s)`}
                </option>
              ))}
            </Input>
          )}
        </div>
        {nudgeError && <p role="alert">{nudgeError}</p>}
      </section>

      <section className="friends-box__add-to-room">
        {/* No heading here either, same reason as the Nudge section above - the ButtonLarge
            already reads "Add to Room (N selected)". */}
        {roomsError && <p role="alert">Couldn't load study rooms: {roomsError}.</p>}
        {rooms !== null && rooms.length === 0 && !roomsError && (
          <p className="sp-text-3">No study rooms yet</p>
        )}
        <div className="friends-box__action-row">
          <ButtonLarge
            onClick={handleAddToRoom}
            disabled={addingToRoom || !roomToAddTo || selectedFriendIds.size === 0}
          >
            {addingToRoom ? "Adding…" : `Add to Room (${selectedFriendIds.size} selected)`}
          </ButtonLarge>
          {rooms !== null && rooms.length > 0 && (
            <Input
              variant="dropdown"
              aria-label="Study room"
              value={roomToAddTo}
              onChange={(e) => setRoomToAddTo(e.target.value)}
            >
              <option value="">Choose a room</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </Input>
          )}
        </div>
        {addToRoomError && <p role="alert">{addToRoomError}</p>}
      </section>

      <section className="friends-box__add">
        <span className="sp-label">Add Friend</span>
        <form className="friends-box__add-row" onSubmit={(e) => void handleAddFriend(e)}>
          <Input
            aria-label="Invite code"
            placeholder="Invite code"
            required
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <ButtonBool
            icon="check"
            type="submit"
            aria-label={joinBusy ? "Adding friend…" : "Add friend"}
            disabled={joinBusy || !joinCode}
          />
        </form>
        {joinError && <p role="alert">Couldn't add your friend: {joinError}. Please try again.</p>}
      </section>

      <section className="friends-box__invite">
        <span className="sp-label">Invite Friend</span>
        <ButtonLarge onClick={() => void handleInviteAFriend()} disabled={inviteBusy}>
          {inviteBusy ? "Setting up your invite…" : "Generate Invite Code"}
        </ButtonLarge>
        {inviteError && (
          <p role="alert">Couldn't generate an invite code: {inviteError}. Please try again.</p>
        )}
        {inviteCode && (
          <p>
            Invite code: <strong>{inviteCode.code}</strong> (expires{" "}
            {new Date(inviteCode.expiresAt).toLocaleString()})
          </p>
        )}
      </section>
    </div>
  );
}
