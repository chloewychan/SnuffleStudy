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

// Every toggleable field, in the order rendered - deliberately groups the three pre-existing
// nudge/digest-axis columns first (familiar from Task 7), then the five new Task 10 fields, so a
// user already familiar with the nudge toggles sees the new ones as a clearly-separate, additional
// group rather than interleaved.
const TOGGLE_FIELDS: { key: keyof FriendshipSettingsPatch; label: string }[] = [
  { key: "sendLiveNudges", label: "I may send this friend a live nudge" },
  { key: "receiveLiveNudges", label: "This friend may send me a live nudge" },
  { key: "receiveDailyDigest", label: "Receive a daily digest about this friend" },
  { key: "shareDistractionAttempts", label: "Share my distraction attempts with this friend" },
  { key: "shareCurrentDomain", label: "Share my current site with this friend" },
  { key: "shareGoalText", label: "Share my session goal text with this friend" },
  { key: "shareInterventionCount", label: "Share my intervention count with this friend" },
  { key: "shareFullHistory", label: "Share my full session history with this friend" },
];

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

      {!selfUserId && !error && (
        <p>
          Sign in on the Account page to manage friend settings.{" "}
          <button type="button" onClick={onSignInClick}>
            Sign in
          </button>
        </p>
      )}

      {selfUserId && friendIds && friendIds.length === 0 && !error && (
        <p>No friends yet — add a friend on the Account page first.</p>
      )}

      {selfUserId &&
        friendIds &&
        friendIds.map((friendId) => {
          const settings = settingsByFriend[friendId];
          return (
            <section key={friendId} className="friends-page__friend">
              <h3>{friendId}</h3>
              {!settings && (
                <p>
                  No settings row yet for this friend — you may not have added each other as
                  friends yet, or they joined before this feature existed.
                </p>
              )}
              {settings &&
                TOGGLE_FIELDS.map(({ key, label }) => {
                  const fieldKey = `${friendId}:${key}`;
                  return (
                    <label key={fieldKey}>
                      <input
                        type="checkbox"
                        checked={Boolean(settings[key])}
                        disabled={savingKey === fieldKey}
                        onChange={(e) => handleToggle(friendId, key, e.target.checked)}
                      />
                      {label}
                    </label>
                  );
                })}
            </section>
          );
        })}
    </div>
  );
}
