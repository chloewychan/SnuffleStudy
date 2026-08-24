import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { Profile } from "../../infrastructure/backend/profileApi";

// v3.3 Task 8: given a list of user ids, fetches display names once via PROFILES_FETCH_BY_IDS and
// returns a `(userId) => string` resolver. Every raw-userId display site this task's plan names
// (NudgeSendForm's friend picker, StudyRoomPanel's participant list, TempPasscodePanel's/
// UnlockRequestPanel's requester lines, LockedPage.tsx's friend picker, AccountPage.tsx's friend
// list) uses this instead of rendering userId text directly. Task 13's room-invitee picker/list is
// a future call site (that UI doesn't exist yet) - not wired here.
//
// PROFILES_FETCH_BY_IDS already degrades to [] on any failure (signed out, network error, RLS
// denying every id - see profileApi.ts's fetchProfilesByIds) - so this hook never throws and never
// surfaces its own error state; a failure just means every id falls back to its own raw value,
// exactly the same as "no profile row exists yet for this id" or "this id's profile has no
// human_name set" already do. bunny_name is deliberately never read here - per the plan, it stays
// BunnyTab.tsx's own concern only.
export function useDisplayNames(userIds: string[]): (userId: string) => string {
  // Joined into a stable, order-independent string so this effect only re-runs when the actual
  // SET of ids changes, not on every render that happens to pass a new array instance with the
  // same ids (every call site below recomputes its id list from other state on each render).
  const key = [...new Set(userIds)].sort().join(",");
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    const ids = key === "" ? [] : key.split(",");
    if (ids.length === 0) {
      setNames({});
      return;
    }

    let cancelled = false;
    sendMessage<{ ok: boolean; profiles?: Profile[]; error?: string }>({
      type: "PROFILES_FETCH_BY_IDS",
      payload: { userIds: ids },
    })
      .then((res) => {
        if (cancelled || !res.ok || !res.profiles) return;
        const next: Record<string, string> = {};
        for (const profile of res.profiles) {
          if (profile.humanName) next[profile.userId] = profile.humanName;
        }
        setNames(next);
      })
      .catch((err) => {
        // Best-effort, same as every other "resolve a friendlier label" fetch in this codebase
        // (e.g. UnlockRequestPanel.tsx's loadBlockedHostnames) - never blocks whatever list this
        // is resolving names for; it just keeps rendering raw ids.
        console.error("Failed to fetch display names", err);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` (a stable, order-independent
    // encoding of the id set) is the real dependency here, not the `userIds` array reference.
  }, [key]);

  return (userId: string) => names[userId] ?? userId;
}
