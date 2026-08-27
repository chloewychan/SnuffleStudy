import { useEffect, useState } from "react";
import { sendMessage } from "../../../infrastructure/messaging/extensionMessenger";
import type { FriendEvent } from "../../../infrastructure/backend/sessionStatusSyncApi";
import type { FriendNudge } from "../../../infrastructure/backend/nudgeApi";
import type { DigestSummary } from "../../../infrastructure/backend/digestApi";
import type { IncomingProducerTag } from "../../../infrastructure/backend/producerTagApi";
import {
  getLastDismissedNudgeSentAt,
  setLastDismissedNudgeSentAt,
} from "../../../infrastructure/storage/nudgeDismissalState";

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
  // QA-discovered bug (v3.4 QA pass): persisted via nudgeDismissalState.ts (chrome.storage.local),
  // not just component state - see that module's own comment for why a plain useState reset to
  // empty on every FriendGroupPanel remount, making a dismissed nudge reappear every time the user
  // left and returned to the Friends tab. `null` here specifically means "not loaded yet from
  // storage" (distinct from 0, a real timestamp) - visibleNudge stays hidden until this resolves,
  // so a previously-dismissed nudge can't flash on screen before we know it was dismissed.
  const [dismissedThroughSentAt, setDismissedThroughSentAt] = useState<number | null>(null);
  const [dismissedCursorLoaded, setDismissedCursorLoaded] = useState(false);

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

  // v3.4 Task 2: discovers who this panel's "send a nudge" picker can target - every friend of
  // the current user, via one FRIENDS_LIST call, replacing the old AUTH_GET_SESSION ->
  // GROUP_LIST_MINE -> Promise.all(GROUP_LIST_MEMBERS) -> dedupe fan-out entirely.
  // selfUserId still comes from a standalone AUTH_GET_SESSION call, since NudgeSendForm.tsx uses
  // it independently of the friends fetch (its sign-in-prompt-vs-empty-list branch).
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

        return sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({
          type: "FRIENDS_LIST",
        }).then((friendsRes) => {
          if (!friendsRes.ok) {
            setFriendsError(friendsRes.error ?? "Could not load your friends.");
            return undefined;
          }
          setFriendIds(friendsRes.friendIds ?? []);
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

    // QA-discovered bug (v3.4 QA pass): loads the persisted dismissal cursor once per mount - see
    // nudgeDismissalState.ts and dismissedThroughSentAt's own comment above.
    getLastDismissedNudgeSentAt()
      .then((sentAt) => setDismissedThroughSentAt(sentAt))
      .catch((err) => {
        // Best-effort: worst case, a previously-dismissed nudge briefly reappears once - not
        // worth surfacing as a user-facing error on top of the panel's other four fetches.
        console.error("Failed to load the last-dismissed-nudge cursor", err);
      })
      .finally(() => setDismissedCursorLoaded(true));

    // QA-discovered bug (v3.3 QA pass): none of the five load* fetches above ever ran again while
    // this panel stayed mounted - only a fresh mount or a manual Refresh click (handleRefresh in
    // FriendGroupPanel.tsx) re-fetched anything. The background friend-poll alarm
    // (alarmHandlers.ts) polls Supabase and fires a chrome.notifications toast on its own
    // "roughly once a minute" cadence (infrastructure/browser/alarmsApi.ts's own header comment),
    // but never told this already-open panel's own React state to refetch - a nudge sent while a
    // recipient's Friends tab was already open simply never appeared until they happened to
    // switch tabs away and back (which only "worked" as a side effect of SidePanelApp.tsx
    // unmounting/remounting this panel via its `{activeTab === "friends" && <FriendsTab />}`
    // conditional rendering, re-running this same mount effect). This interval closes that gap by
    // re-running the exact same five fetches on the same ~1-minute cadence the backend alarm
    // already uses, matching the v3.2 QA script's own item 4 expectation ("within a few
    // seconds... give it a full poll cycle if it doesn't appear instantly").
    const intervalId = setInterval(() => {
      loadEvents();
      loadFriends();
      loadNudges();
      loadDigests();
      loadProducerTags();
    }, 60_000);
    return () => clearInterval(intervalId);
  }, []);

  // QA-discovered bug (v3.4 QA pass): advances the persisted cursor, not just local state - a
  // dismissal that only updated React state disappeared the moment FriendGroupPanel unmounted.
  // Looks the nudge up by id (rather than requiring the caller to pass its sentAt directly) so
  // this function's own call sites - just IncomingNudgeCard.tsx's onDismiss={() =>
  // dismissNudge(visibleNudge.id)} - don't need to change.
  function dismissNudge(nudgeId: string) {
    const nudge = incomingNudges?.find((n) => n.id === nudgeId);
    if (!nudge) return;
    setDismissedThroughSentAt(nudge.sentAt);
    setLastDismissedNudgeSentAt(nudge.sentAt).catch((err) => {
      // Standing convention in this codebase: never leave an async call triggered from a UI
      // handler unhandled. Best-effort - the in-memory setDismissedThroughSentAt call above
      // already updated what's shown this session; a failure here only risks the nudge
      // reappearing on the NEXT mount, not right now.
      console.error("Failed to persist the dismissed-nudge cursor", err);
    });
  }

  // Hidden entirely until the persisted cursor has loaded (dismissedCursorLoaded), so a
  // previously-dismissed nudge can't flash on screen for one render before we know it was already
  // dismissed - see dismissedThroughSentAt's own comment.
  const visibleNudge = dismissedCursorLoaded
    ? (incomingNudges?.find(
        (n) => dismissedThroughSentAt === null || n.sentAt > dismissedThroughSentAt
      ) ?? null)
    : null;

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
