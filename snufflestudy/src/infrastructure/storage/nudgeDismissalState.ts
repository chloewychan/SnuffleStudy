// FriendGroupPanel's IncomingNudgeCard "Dismiss" action is persisted here rather than kept only
// in useFriendGroupPanelData's React state, because component-local state resets to empty every
// time FriendGroupPanel unmounts - e.g. leaving and returning to the sidepanel's Friends tab, per
// SidePanelApp.tsx's `{activeTab === "friends" && <FriendsTab />}` conditional rendering. Without
// persistence, a dismissed nudge would reappear on every return, indefinitely, until it aged out
// of loadNudges' 24h lookback window. Mirrors this codebase's established chrome.storage.local
// cursor pattern (see friendPollState.ts) rather than inventing a new shape - kept as its own
// small module rather than folded into that file, since its callers (useFriendGroupPanelData/
// useIncomingActivity, both UI hooks) and purpose (a user-driven "I've seen this" dismissal, not a
// background poll's delivery cursor) are both genuinely different from every cursor there.
//
// Dismissals are stored as a persisted SET of item ids rather than a single "dismissed everything
// through this sent_at" watermark, because NudgesAndRequestsFooter.tsx
// (sidepanel/components/NudgesAndRequestsFooter.tsx, via sidepanel/appFooter/useIncomingActivity.ts)
// shows every undismissed nudge simultaneously, each with its own Dismiss button - dismissing a
// newer nudge while an older one is still visible is a normal, expected action that a single
// watermark cannot represent (advancing it past the newer one would also hide the older one). A
// bare nudge id isn't enough either: useIncomingActivity.ts also folds in incoming Producer Tag
// sends (PRODUCER_TAG_SENDS_FETCH, the "audio nudge") as a second, independently-dismissible
// stream sharing this same persisted set - nudges.id and producer_tag_sends' tag id are drawn from
// different tables and are not guaranteed distinct from each other, so each dismissed entry is
// keyed by `{ kind, id }`, not `id` alone.
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
