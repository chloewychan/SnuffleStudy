import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type {
  FriendshipSettings,
  FriendshipSettingsPatch,
} from "../../infrastructure/backend/friendshipSettingsApi";

// v2 Task 10: the Friends section of OptionsApp - per-friend visibility toggles (the three
// pre-existing friendship_settings booleans from Task 5/7, plus Task 10's five new share_*
// columns), enforced server-side by the RLS/RPC changes in
// supabase/migrations/20260815000012_v2_privacy_controls.sql, not just hidden here in the UI.
//
// Minimal shape of what AUTH_GET_SESSION's response carries that this page actually needs -
// mirrors AccountPage.tsx's/FriendGroupPanel.tsx's identical minimal AuthUser/AuthSession shapes.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

// v4.1 Task 9: seven fields, in the order rendered - the daily-digest checkbox (receiveDailyDigest)
// is dropped here, along with the rest of the digest feature (scope doc's Friends Tab section) -
// no longer eight fields as it was through v3.4. Deliberately groups the two remaining
// pre-existing nudge-axis columns first (familiar from Task 7), then the five Task 10 fields, so a
// user already familiar with the nudge toggles sees the new ones as a clearly-separate, additional
// group rather than interleaved.
const TOGGLE_FIELDS: { key: keyof FriendshipSettingsPatch; label: string }[] = [
  { key: "sendLiveNudges", label: "I may send this friend a live nudge" },
  { key: "receiveLiveNudges", label: "This friend may send me a live nudge" },
  { key: "shareDistractionAttempts", label: "Share my distraction attempts with this friend" },
  { key: "shareCurrentDomain", label: "Share my current site with this friend" },
  { key: "shareGoalText", label: "Share my session goal text with this friend" },
  { key: "shareInterventionCount", label: "Share my intervention count with this friend" },
  { key: "shareFullHistory", label: "Share my full session history with this friend" },
];

// v4.1 Task 9: extracted so FriendsBox.tsx (the new sidepanel Friends-tab box) can reuse the exact
// same seven-checkbox render loop + Remove friend button inside its own per-friend Options
// popover, rather than duplicating this markup - see that file's own comment for how it wires
// friendId/settings/savingKey/onToggle/onRemove/removing from its own state, mirroring this page's
// own handleToggle/handleRemove shape exactly (same optimistic-update convention, same
// per-(friendId,field) savingKey scoping).
//
// v4.2 Task 9: optional `classNames` lets a caller with its own visual design (the sidepanel's new
// FriendOptionsPopup, built from frontend-backup's FriendDetailsPopup.tsx markup) style this same
// render loop's checkboxes/remove-button to match its own CSS Module, without touching this page's
// own plain, unstyled rendering (FriendsPage.tsx itself has no frontend-backup equivalent and is
// out of this plan's scope - it never passes `classNames`, so its DOM output is byte-identical to
// before). Additive/optional/backward-compatible, the same pattern Tasks 5/7 used to extend
// IconButton/ButtonLarge/TextInput with real interactivity props.
export interface FriendSettingsFieldsClassNames {
  row?: string;
  checkbox?: string;
  labelText?: string;
  removeButton?: string;
  removeButtonText?: string;
}

export interface FriendSettingsFieldsProps {
  friendId: string;
  settings: FriendshipSettings | undefined;
  savingKey: string | null;
  onToggle: (friendId: string, field: keyof FriendshipSettingsPatch, checked: boolean) => void;
  onRemove: (friendId: string) => void;
  removing: boolean;
  classNames?: FriendSettingsFieldsClassNames;
}

export function FriendSettingsFields({
  friendId,
  settings,
  savingKey,
  onToggle,
  onRemove,
  removing,
  classNames,
}: FriendSettingsFieldsProps) {
  return (
    <>
      {!settings && (
        <p>
          No settings row yet for this friend — you may not have added each other as friends yet,
          or they joined before this feature existed.
        </p>
      )}
      {settings &&
        TOGGLE_FIELDS.map(({ key, label }) => {
          const fieldKey = `${friendId}:${key}`;
          return (
            <label key={fieldKey} className={classNames?.row}>
              <input
                type="checkbox"
                className={classNames?.checkbox}
                checked={Boolean(settings[key])}
                disabled={savingKey === fieldKey}
                onChange={(e) => onToggle(friendId, key, e.target.checked)}
              />
              {classNames?.labelText ? <span className={classNames.labelText}>{label}</span> : label}
            </label>
          );
        })}
      <button
        type="button"
        className={classNames?.removeButton}
        onClick={() => onRemove(friendId)}
        disabled={removing}
      >
        {classNames?.removeButtonText ? (
          <span className={classNames.removeButtonText}>
            {removing ? "Removing…" : "Remove friend"}
          </span>
        ) : removing ? (
          "Removing…"
        ) : (
          "Remove friend"
        )}
      </button>
    </>
  );
}

interface FriendsPageProps {
  onSignInClick?: () => void;
}

export function FriendsPage({ onSignInClick }: FriendsPageProps) {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [settingsByFriend, setSettingsByFriend] = useState<Record<string, FriendshipSettings>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks which specific (friendId, field) toggle is mid-save, so only that one checkbox
  // disables rather than the whole page - mirrors this codebase's existing per-action busy-state
  // convention (AccountPage.tsx's inviteBusy/joinBusy/membersBusy, each scoped to one action).
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // v4.1 Task 9: "Remove friend" is now triggerable from wherever a friend's settings render, not
  // just AccountPage.tsx (whose own "Your friends" section this task's sibling deliverable,
  // FriendsBox.tsx, replaces) - added here so FriendSettingsFields' onRemove has a real handler on
  // both callers. Same busy/error state shape as AccountPage.tsx's own handleRemoveFriend.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // v3.4 Task 2: discovers who this page can show settings for - every friend of the current
  // user, via one FRIENDS_LIST call, replacing the old AUTH_GET_SESSION -> GROUP_LIST_MINE ->
  // Promise.all(GROUP_LIST_MEMBERS) -> dedupe fan-out entirely, same simplification as
  // useFriendGroupPanelData.ts's loadFriends()/LockedPage.tsx's/StudyRoomPanel.tsx's identical
  // fix - "who is a friend" now has the same definition everywhere in this codebase: an actual
  // pairwise friendships row.
  function load() {
    setLoading(true);
    setError(null);
    sendMessage<{ ok: boolean; session?: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((sessionRes) => {
        if (!sessionRes.ok) {
          setError(sessionRes.error ?? "Could not verify your sign-in status.");
          return undefined;
        }
        const userId = sessionRes.session?.user.id ?? null;
        setSelfUserId(userId);
        if (!userId) {
          setFriendIds([]);
          return undefined;
        }

        return sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({
          type: "FRIENDS_LIST",
        }).then((friendsRes) => {
          if (!friendsRes.ok) {
            setError(friendsRes.error ?? "Could not load your friends.");
            return undefined;
          }
          const ids = friendsRes.friendIds ?? [];
          setFriendIds(ids);
          return sendMessage<{ ok: boolean; settings?: FriendshipSettings[]; error?: string }>({
            type: "FRIENDSHIP_SETTINGS_LIST",
          }).then((settingsRes) => {
            if (!settingsRes.ok) {
              setError(settingsRes.error ?? "Could not load friend settings.");
              return;
            }
            const byFriend: Record<string, FriendshipSettings> = {};
            for (const row of settingsRes.settings ?? []) {
              byFriend[row.friendUserId] = row;
            }
            setSettingsByFriend(byFriend);
          });
        });
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races, or
        // extension-context-invalidated.
        console.error("Failed to load friends settings", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleToggle(friendId: string, field: keyof FriendshipSettingsPatch, checked: boolean) {
    const key = `${friendId}:${field}`;
    setSavingKey(key);
    setSaveError(null);
    const previous = settingsByFriend[friendId];
    // Optimistic update - matches OptionsApp.tsx's updateSettings() pattern: reflect the change
    // immediately, roll back if the save fails.
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

  // v4.1 Task 9: mirrors AccountPage.tsx's own handleRemoveFriend exactly (either party can
  // unilaterally end the friendship) - optimistic-on-confirmed-success removal from local
  // `friendIds` state rather than a full reload.
  function handleRemove(friendId: string) {
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
      })
      .catch((err) => {
        console.error("Failed to remove a friend", err);
        setRemoveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setRemovingId(null));
  }

  if (loading && friendIds === null) {
    return (
      <div className="friends-page">
        <h2>Friends</h2>
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="friends-page">
      <h2>Friends</h2>
      <p>
        Choose what each friend can see about your sessions. Off by default for everything new —
        turn on only what you're comfortable sharing.
      </p>

      {error && <p role="alert">Couldn't load friend settings: {error}. Please try again.</p>}
      {saveError && <p role="alert">Couldn't save: {saveError}. Please try again.</p>}
      {removeError && (
        <p role="alert">Couldn't remove this friend: {removeError}. Please try again.</p>
      )}

      {!selfUserId && !error && (
        <p>
          Sign in on the Account page to manage friend settings.{" "}
          <button type="button" onClick={onSignInClick}>
            Sign in
          </button>
        </p>
      )}

      {selfUserId && friendIds && friendIds.length === 0 && !error && (
        <p>No friends yet — add a friend from the sidebar's Friends tab first.</p>
      )}

      {selfUserId &&
        friendIds &&
        friendIds.map((friendId) => {
          const settings = settingsByFriend[friendId];
          return (
            <section key={friendId} className="friends-page__friend">
              <h3>{friendId}</h3>
              <FriendSettingsFields
                friendId={friendId}
                settings={settings}
                savingKey={savingKey}
                onToggle={handleToggle}
                onRemove={handleRemove}
                removing={removingId === friendId}
              />
            </section>
          );
        })}
    </div>
  );
}
