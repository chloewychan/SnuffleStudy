import { useCallback, useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { IncomingProducerTag } from "../../infrastructure/backend/producerTagApi";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import {
  getDismissedNudgeIds,
  markNudgeDismissed,
  encodeDismissedItemKey,
} from "../../infrastructure/storage/nudgeDismissalState";

// v4.1 Task 8: powers the persistent Nudges & Unlock Requests footer (NudgesAndRequestsFooter.tsx,
// mounted once inside AppFooter.tsx - this hook itself is only ever instantiated once, there).
// Three independent streams, each moved with no behavior change to its own underlying fetch/resolve
// call from where it used to live:
//   - nudges/incomingTags: moved from useFriendGroupPanelData.ts's loadNudges/loadProducerTags -
//     same NUDGES_FETCH/PRODUCER_TAG_SENDS_FETCH calls, same 24h lookback. Filtered against the
//     persisted dismissed-item set (nudgeDismissalState.ts, Decision 3) instead of a single
//     watermark - every undismissed item is returned, not just the single oldest one, since the new
//     footer shows all of them simultaneously (each with its own Dismiss button).
//   - requests: moved from the old standalone approver-side panel's loadSelf/loadRequests/
//     handleResolve, unchanged in logic (same FRIEND_REQUESTS_FETCH/FRIEND_REQUEST_RESOLVE/
//     FRIEND_REQUEST_APPROVE_TEMP_PASS calls, same first-responder-wins error handling, same
//     "pending, not from myself" filter).
//
// A note on scope: FriendGroupPanel.tsx (and its own IncomingNudgeCard/NudgeSendSection children)
// still independently fetch/render/dismiss the same nudges and producer-tag sends today - that
// duplication is real but temporary and expected, not a bug introduced here. Task 9 deletes
// FriendGroupPanel.tsx (and useFriendGroupPanelData.ts) wholesale; until it lands, both the old
// overlay/list (in the Friends tab) and this new persistent footer independently show the same
// underlying data, each with its own dismissal bookkeeping (both now backed by the same
// nudgeDismissalState.ts id-set, so a dismissal in one place - keyed by the same `{kind, id}` - is
// also respected by the other).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Mirrors useFriendGroupPanelData.ts's own "re-fetch on the same ~1-minute cadence the backend
// friend-poll alarm uses" fix (v3.3 QA pass) - this hook now lives at the app-shell level and never
// unmounts/remounts on a tab switch the way the old standalone approver-side panel used to (which
// relied on that remount as its only "refresh" beyond its own local Refresh button), so it needs
// the same interval-based re-fetch nudges/tags already have, or a pending request would only ever
// update via the Header's Refresh button.
const POLL_INTERVAL_MS = 60_000;

// producer_tag_sends has no send-specific id of its own exposed on IncomingProducerTag (see that
// interface's own comment - it's a joined view, not a domain type) - IncomingProducerTagCard.tsx's
// existing React `key` already disambiguates the same way (`${tagId}-${sentAt}`), since the same
// saved tag could in principle be sent more than once. Reused here as this stream's dismissal id.
function tagDismissalId(tag: IncomingProducerTag): string {
  return `${tag.tagId}-${tag.sentAt}`;
}

export interface IncomingActivity {
  nudges: FriendNudge[]; // all undismissed, oldest first
  nudgesError: string | null;
  incomingTags: IncomingProducerTag[]; // all undismissed incoming audio nudges, oldest first
  tagsError: string | null;
  requests: FriendRequest[]; // all pending, from others
  requestsError: string | null;
  resolvingRequestId: string | null;
  resolveError: string | null;
  dismissNudge(id: string): void;
  dismissTag(tag: IncomingProducerTag): void;
  resolveRequest(request: FriendRequest, decision: "approved" | "denied"): void;
  refresh(): void;
}

export function useIncomingActivity(): IncomingActivity {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [selfLoaded, setSelfLoaded] = useState(false);

  const [rawNudges, setRawNudges] = useState<FriendNudge[]>([]);
  const [nudgesError, setNudgesError] = useState<string | null>(null);

  const [rawTags, setRawTags] = useState<IncomingProducerTag[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);

  const [rawRequests, setRawRequests] = useState<FriendRequest[]>([]);
  const [requestsError, setRequestsError] = useState<string | null>(null);

  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Decision 3: a shared dismissed-item id set (persisted via nudgeDismissalState.ts), keyed by
  // `{kind, id}` so a nudge id and an (accidentally) matching tag-dismissal id never collide.
  // `null` specifically means "not loaded from storage yet" - both nudges/incomingTags stay empty
  // until this resolves, so an already-dismissed item can't flash on screen for one render.
  const [dismissedIds, setDismissedIds] = useState<Set<string> | null>(null);

  const loadSelf = useCallback(() => {
    sendMessage<{ ok: boolean; session?: { user: { id: string } } | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (res.ok) setSelfUserId(res.session?.user.id ?? null);
      })
      .catch((err) => {
        console.error("Failed to load current user for incoming activity", err);
      })
      .finally(() => setSelfLoaded(true));
  }, []);

  const loadNudges = useCallback(() => {
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
        setRawNudges(res.nudges ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch incoming nudges", err);
        setNudgesError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const loadTags = useCallback(() => {
    setTagsError(null);
    sendMessage<{ ok: boolean; sends?: IncomingProducerTag[]; error?: string }>({
      type: "PRODUCER_TAG_SENDS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok) {
          setTagsError(res.error ?? "Could not load incoming audio nudges.");
          return;
        }
        setRawTags(res.sends ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch incoming producer tags", err);
        setTagsError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const loadRequests = useCallback(() => {
    setRequestsError(null);
    sendMessage<{ ok: boolean; requests?: FriendRequest[]; error?: string }>({
      type: "FRIEND_REQUESTS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok) {
          setRequestsError(res.error ?? "Could not load friend requests.");
          return;
        }
        setRawRequests(res.requests ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch friend requests", err);
        setRequestsError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const refresh = useCallback(() => {
    loadRequests();
    loadNudges();
    loadTags();
  }, [loadRequests, loadNudges, loadTags]);

  useEffect(() => {
    loadSelf();
    refresh();

    getDismissedNudgeIds()
      .then((ids) => setDismissedIds(ids))
      .catch((err) => {
        // Best-effort, same convention as useFriendGroupPanelData.ts's identical load - worst
        // case, an already-dismissed item briefly reappears once.
        console.error("Failed to load the dismissed-activity set", err);
        setDismissedIds(new Set());
      });

    // Mirrors useFriendGroupPanelData.ts's own fix (v3.3 QA pass) - see this file's own header
    // comment for why requests now join the same interval nudges/tags already had.
    const intervalId = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSelf/refresh are stable
    // (useCallback with empty/stable deps); this effect is intentionally mount-only otherwise.
  }, []);

  function dismissNudge(nudgeId: string) {
    const key = encodeDismissedItemKey({ kind: "nudge", id: nudgeId });
    setDismissedIds((prev) => new Set(prev).add(key));
    markNudgeDismissed({ kind: "nudge", id: nudgeId }).catch((err) => {
      // Standing convention in this codebase: never leave an async call triggered from a UI
      // handler unhandled. Best-effort - the in-memory update above already updated what's shown
      // this session; a failure here only risks the item reappearing on the next mount.
      console.error("Failed to persist the dismissed nudge", err);
    });
  }

  function dismissTag(tag: IncomingProducerTag) {
    const id = tagDismissalId(tag);
    const key = encodeDismissedItemKey({ kind: "tag", id });
    setDismissedIds((prev) => new Set(prev).add(key));
    markNudgeDismissed({ kind: "tag", id }).catch((err) => {
      console.error("Failed to persist the dismissed audio nudge", err);
    });
  }

  function resolveRequest(request: FriendRequest, decision: "approved" | "denied") {
    setResolvingRequestId(request.id);
    setResolveError(null);
    // Decision 3 (friend_requests, not this task's own Decision 3): approving a site_temp_pass
    // request must go through the approve-temp-passcode Edge Function - the ONE friend_requests
    // mutation that does not go through the shared FRIEND_REQUEST_RESOLVE path. Moved verbatim
    // from the old standalone approver-side panel's handleResolve.
    const usesTempPassApproval = decision === "approved" && request.kind === "site_temp_pass";
    const send = usesTempPassApproval
      ? sendMessage<{ ok: boolean; error?: string }>({
          type: "FRIEND_REQUEST_APPROVE_TEMP_PASS",
          payload: { requestId: request.id },
        })
      : sendMessage<{ ok: boolean; error?: string }>({
          type: "FRIEND_REQUEST_RESOLVE",
          payload: { requestId: request.id, decision },
        });

    send
      .then((res) => {
        if (!res.ok) {
          // Server-side rejection - most commonly another friend already resolved this request
          // first ("first responder wins"). Surfaced inline, then the list is refreshed so this
          // request's real current state replaces the stale pending row here - same convention the
          // old standalone approver-side panel already used.
          setResolveError(
            res.error ?? "Could not resolve that request — a friend may have already answered it."
          );
          loadRequests();
          return;
        }
        setRawRequests((prev) =>
          prev.map((r) => (r.id === request.id ? { ...r, status: decision } : r))
        );
      })
      .catch((err) => {
        console.error("Failed to resolve friend request", err);
        setResolveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResolvingRequestId(null));
  }

  const nudges =
    dismissedIds === null
      ? []
      : rawNudges.filter((n) => !dismissedIds.has(encodeDismissedItemKey({ kind: "nudge", id: n.id })));

  const incomingTags =
    dismissedIds === null
      ? []
      : rawTags.filter(
          (t) => !dismissedIds.has(encodeDismissedItemKey({ kind: "tag", id: tagDismissalId(t) }))
        );

  // Guarded on selfLoaded, not just "selfUserId truthy" - mirrors the old standalone
  // approver-side panel's identical guard: until loadSelf()'s round trip resolves, who-am-I is
  // genuinely unknown, so rendering no requests avoids a flash of the viewer's own pending
  // request if loadRequests() resolves first.
  const requests = selfLoaded
    ? rawRequests.filter((r) => r.status === "pending" && r.requesterUserId !== selfUserId)
    : [];

  return {
    nudges,
    nudgesError,
    incomingTags,
    tagsError,
    requests,
    requestsError,
    resolvingRequestId,
    resolveError,
    dismissNudge,
    dismissTag,
    resolveRequest,
    refresh,
  };
}
