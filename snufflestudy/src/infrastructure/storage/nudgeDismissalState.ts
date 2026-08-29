// QA-discovered bug (v3.4 QA pass): FriendGroupPanel's IncomingNudgeCard "Dismiss" action
// previously lived only in useFriendGroupPanelData's React state (a plain useState Set of
// dismissed ids), which resets to empty every time FriendGroupPanel unmounts - e.g. leaving and
// returning to the sidepanel's Friends tab, per SidePanelApp.tsx's
// `{activeTab === "friends" && <FriendsTab />}` conditional rendering. A dismissed nudge would
// therefore reappear on every return, indefinitely, until it aged out of loadNudges' 24h lookback
// window. Mirrors this codebase's established chrome.storage.local cursor pattern (see
// friendPollState.ts) rather than inventing a new shape - kept as its own small module rather than
// folded into that file, since its callers (useFriendGroupPanelData/useIncomingActivity, both UI
// hooks) and purpose (a user-driven "I've seen this" dismissal, not a background poll's delivery
// cursor) are both genuinely different from every cursor there.
//
// v4.1 Task 8 (Decision 3): redesigned from a single "dismissed everything through this sent_at"
// watermark (getLastDismissedNudgeSentAt/setLastDismissedNudgeSentAt) to a persisted SET of
// dismissed item ids. The watermark model relied on FriendGroupPanel.tsx only ever surfacing the
// single oldest not-yet-dismissed nudge at a time - dismissal only ever happened in strictly
// increasing sent_at order, so a cursor was behaviorally equivalent to (and simpler than) a full id
// set. The new NudgesAndRequestsFooter.tsx (sidepanel/components/NudgesAndRequestsFooter.tsx, via
// sidepanel/appFooter/useIncomingActivity.ts) shows every undismissed nudge simultaneously, each
// with its own Dismiss button - dismissing a newer nudge while an older one is still visible is now
// a normal, expected action a single watermark cannot represent (advancing it past the newer one
// would also hide the older one). A bare nudge id isn't enough either: useIncomingActivity.ts also
// folds in incoming Producer Tag sends (PRODUCER_TAG_SENDS_FETCH, today's "audio nudge") as a
// second, independently-dismissible stream sharing this same persisted set - nudges.id and
// producer_tag_sends' tag id are drawn from different tables and are not guaranteed distinct from
// each other, so each dismissed entry is keyed by `{ kind, id }`, not `id` alone.
export type DismissibleItemKind = "nudge" | "tag";

export interface DismissedItemKey {
  kind: DismissibleItemKind;
  id: string;
}

const DISMISSED_NUDGE_IDS_KEY = "snufflestudy.dismissedNudgeIds";

// Exported so callers checking `dismissedIds.has(...)` (useIncomingActivity.ts,
// useFriendGroupPanelData.ts) encode the same way this module persists - not duplicated ad hoc at
// each call site.
export function encodeDismissedItemKey({ kind, id }: DismissedItemKey): string {
  return `${kind}:${id}`;
}

export async function getDismissedNudgeIds(): Promise<Set<string>> {
  const result = await chrome.storage.local.get<Record<typeof DISMISSED_NUDGE_IDS_KEY, string[]>>(
    DISMISSED_NUDGE_IDS_KEY
  );
  return new Set(result[DISMISSED_NUDGE_IDS_KEY] ?? []);
}

export async function markNudgeDismissed(key: DismissedItemKey): Promise<void> {
  const current = await getDismissedNudgeIds();
  current.add(encodeDismissedItemKey(key));
  await chrome.storage.local.set({ [DISMISSED_NUDGE_IDS_KEY]: [...current] });
}
