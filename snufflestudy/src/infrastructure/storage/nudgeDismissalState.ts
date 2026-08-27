// QA-discovered bug (v3.4 QA pass): FriendGroupPanel's IncomingNudgeCard "Dismiss" action
// previously lived only in useFriendGroupPanelData's React state (a plain useState Set of
// dismissed ids), which resets to empty every time FriendGroupPanel unmounts - e.g. leaving and
// returning to the sidepanel's Friends tab, per SidePanelApp.tsx's
// `{activeTab === "friends" && <FriendsTab />}` conditional rendering. A dismissed nudge would
// therefore reappear on every return, indefinitely, until it aged out of loadNudges' 24h lookback
// window.
//
// nudgeApi.ts's fetchIncomingNudges orders by sent_at ascending, and
// useFriendGroupPanelData.visibleNudge always surfaces the single oldest not-yet-dismissed nudge
// (IncomingNudgeCard's own header comment confirms this "one at a time, oldest first" contract) -
// dismissal therefore only ever happens in strictly increasing sent_at order, so a single
// "dismissed everything through this sent_at" cursor is behaviorally equivalent to persisting a
// full set of dismissed ids, and far simpler. Mirrors this codebase's established
// chrome.storage.local cursor pattern (see friendPollState.ts) rather than inventing a new shape -
// kept as its own small module rather than folded into that file, since its caller
// (useFriendGroupPanelData, a UI hook) and purpose (a user-driven "I've seen this" dismissal, not
// a background poll's delivery cursor) are both genuinely different from every cursor there.
const LAST_DISMISSED_NUDGE_SENT_AT_KEY = "snufflestudy.lastDismissedNudgeSentAt";

export async function getLastDismissedNudgeSentAt(): Promise<number | null> {
  const result = await chrome.storage.local.get<Record<typeof LAST_DISMISSED_NUDGE_SENT_AT_KEY, number>>(
    LAST_DISMISSED_NUDGE_SENT_AT_KEY
  );
  return result[LAST_DISMISSED_NUDGE_SENT_AT_KEY] ?? null;
}

export async function setLastDismissedNudgeSentAt(sentAt: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_DISMISSED_NUDGE_SENT_AT_KEY]: sentAt });
}
