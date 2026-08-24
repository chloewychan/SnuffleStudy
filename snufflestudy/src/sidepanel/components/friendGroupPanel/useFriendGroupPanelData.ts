import { useEffect, useState } from "react";
import { sendMessage } from "../../../infrastructure/messaging/extensionMessenger";
import type { FriendEvent } from "../../../infrastructure/backend/sessionStatusSyncApi";
import type { FriendNudge } from "../../../infrastructure/backend/nudgeApi";
import type { GroupMembership } from "../../../infrastructure/backend/friendGroupApi";
import type { DigestSummary } from "../../../infrastructure/backend/digestApi";
import type { IncomingProducerTag } from "../../../infrastructure/backend/producerTagApi";

// Default lookback window for this panel's fetch/refresh - a point-in-time view of recent
// activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll alarm,
// which tracks its own separate "last checked" cursors via friendPollState.ts for
// chrome.notifications toasts, one for session events and one for nudges - v2 Task 7). 24h is a
// reasonable "what's been happening" window without needing its own persisted "last viewed"
// cursor. Shared by both the friend-events fetch and the incoming-nudges fetch below.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Minimal shape of what AUTH_GET_SESSION's response carries that this panel actually needs -
// mirrors AccountPage.tsx's identical minimal AuthUser/AuthSession shapes.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

// v2 Task 9: yesterday's UTC calendar date, formatted as daily_digests.digest_date expects
// (YYYY-MM-DD). compute_daily_digests() (supabase/migrations/20260815000010_v2_daily_digests.sql)
// defaults to aggregating `current_date - 1` on its once-daily schedule, so "yesterday" is the
// most recent date a digest row can realistically exist for by the time a user opens this panel -
// the brief's "'today' (or the most recent available date)" wording is satisfied by picking that
// date directly rather than trying "today" first and falling back (which would almost always miss
// on the first attempt and add a second round trip for no benefit).
function yesterdayDateString(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// v3.2 Task 7: extracted from FriendGroupPanel.tsx with no behavior change - owns the panel's
// five independent load* fetches (events, friends, nudges, digests, producer tags) and all of
// their state, plus the small derived values (visibleNudge, friendDigests) and the dismiss action
// that only make sense evaluated against that same state. The initial fire-all-five mount effect
// moves here too, since it's the natural completion of "wrapping the five load* functions."
//
// What deliberately did NOT move here: `selectedFriendId`/`effectiveFriendId` (shared UI state
// between two sibling sections, not fetch state - see FriendGroupPanel.tsx's own comment) and the
// nudge-send/producer-tag *send* flows (NUDGE_SEND, PRODUCER_TAG_UPLOAD/SEND_TO_FRIEND - each
// stays local to the section that triggers it, since nothing else needs that busy/error/success
// state).
export function useFriendGroupPanelData() {
  const [events, setEvents] = useState<FriendEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsLoading, setFriendsLoading] = useState(false);

  const [incomingNudges, setIncomingNudges] = useState<FriendNudge[] | null>(null);
  const [nudgesError, setNudgesError] = useState<string | null>(null);
  const [dismissedNudgeIds, setDismissedNudgeIds] = useState<Set<string>>(new Set());

  const [digests, setDigests] = useState<DigestSummary[] | null>(null);
  const [digestsError, setDigestsError] = useState<string | null>(null);

  // v2 Task 14: Producer Tags (friend-delivery side - see PRODUCER_TAG_SENDS_FETCH's own comment
  // in shared/messages.ts for why room sends never appear here).
  const [incomingTags, setIncomingTags] = useState<IncomingProducerTag[] | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);

  function loadEvents() {
    setLoading(true);
    setError(null);
    sendMessage<{ ok: boolean; events?: FriendEvent[]; error?: string }>({
      type: "FRIEND_EVENTS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok || !res.events) {
          setError(res.error ?? "Could not load friend activity.");
          return;
        }
        setEvents(res.events);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated.
        console.error("Failed to fetch friend events", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  function loadNudges() {
    setNudgesError(null);
    sendMessage<{ ok: boolean; nudges?: FriendNudge[]; error?: string }>({
      type: "NUDGES_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok) {
          setNudgesError(res.error ?? "Could not load incoming nudges.");
          return;
        }
        setIncomingNudges(res.nudges ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch incoming nudges", err);
        setNudgesError(err instanceof Error ? err.message : String(err));
      });
  }

  function loadDigests() {
    setDigestsError(null);
    sendMessage<{ ok: boolean; digests?: DigestSummary[]; error?: string }>({
      type: "DIGEST_FETCH",
      payload: { date: yesterdayDateString() },
    })
      .then((res) => {
        if (!res.ok) {
          setDigestsError(res.error ?? "Could not load the daily digest.");
          return;
        }
        setDigests(res.digests ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch daily digest", err);
        setDigestsError(err instanceof Error ? err.message : String(err));
      });
  }

  // v2 Task 14: on-demand fetch of Producer Tags friends have sent the current user - mirrors
  // loadNudges/loadDigests's identical shape exactly.
  function loadProducerTags() {
    setTagsError(null);
    sendMessage<{ ok: boolean; sends?: IncomingProducerTag[]; error?: string }>({
      type: "PRODUCER_TAG_SENDS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok) {
          setTagsError(res.error ?? "Could not load producer tags.");
          return;
        }
        setIncomingTags(res.sends ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch incoming producer tags", err);
        setTagsError(err instanceof Error ? err.message : String(err));
      });
  }

  // Discovers who this panel's "send a nudge" picker can target: every distinct member (minus
  // the current user) across every group the current user belongs to. There is no "list my
  // groups" fetch anywhere else in this codebase yet (AccountPage.tsx only ever remembers the
  // single group it just created/joined, in local component state - see friendGroupApi.ts's
  // listMyGroups() comment), so this is the first caller of that new function/message.
  function loadFriends() {
    setFriendsLoading(true);
    setFriendsError(null);
    sendMessage<{ ok: boolean; session?: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((sessionRes) => {
        if (!sessionRes.ok) {
          setFriendsError(sessionRes.error ?? "Could not verify your sign-in status.");
          return undefined;
        }
        const userId = sessionRes.session?.user.id ?? null;
        setSelfUserId(userId);
        if (!userId) {
          setFriendIds([]);
          return undefined;
        }

        return sendMessage<{ ok: boolean; memberships?: GroupMembership[]; error?: string }>({
          type: "GROUP_LIST_MINE",
        }).then((groupsRes) => {
          if (!groupsRes.ok) {
            setFriendsError(groupsRes.error ?? "Could not load your groups.");
            return undefined;
          }
          const memberships = groupsRes.memberships ?? [];
          if (memberships.length === 0) {
            setFriendIds([]);
            return undefined;
          }

          return Promise.all(
            memberships.map((m) =>
              sendMessage<{ ok: boolean; members?: GroupMembership[]; error?: string }>({
                type: "GROUP_LIST_MEMBERS",
                payload: { groupId: m.groupId },
              })
            )
          ).then((memberResponses) => {
            const ids = new Set<string>();
            for (const res of memberResponses) {
              if (!res.ok || !res.members) continue;
              for (const member of res.members) {
                if (member.userId !== userId) ids.add(member.userId);
              }
            }
            setFriendIds([...ids]);
          });
        });
      })
      .catch((err) => {
        console.error("Failed to load friends to nudge", err);
        setFriendsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setFriendsLoading(false));
  }

  useEffect(() => {
    loadEvents();
    loadFriends();
    loadNudges();
    loadDigests();
    loadProducerTags();
  }, []);

  function dismissNudge(nudgeId: string) {
    setDismissedNudgeIds((prev) => new Set(prev).add(nudgeId));
  }

  const visibleNudge = incomingNudges?.find((n) => !dismissedNudgeIds.has(n.id)) ?? null;

  // digestApi.fetchDigestForDate deliberately does NOT filter out the caller's own row (see that
  // file's own comment) - this panel is specifically the "friend activity" view, so it filters
  // self out here at display time rather than showing a user a card about their own stats
  // alongside their friends'.
  const friendDigests = digests?.filter((d) => d.friendUserId !== selfUserId) ?? null;

  return {
    events,
    error,
    loading,
    loadEvents,

    selfUserId,
    friendIds,
    friendsError,
    friendsLoading,
    loadFriends,

    nudgesError,
    visibleNudge,
    dismissNudge,
    loadNudges,

    friendDigests,
    digestsError,
    loadDigests,

    incomingTags,
    tagsError,
    loadProducerTags,
  };
}
