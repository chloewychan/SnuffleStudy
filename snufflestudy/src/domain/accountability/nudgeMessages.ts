// v2 Task 7: the fixed catalog of predefined nudges a friend can send. sendNudge(friendUserId,
// messageId) takes a messageId rather than free text - the sender picks one of these, they don't
// write their own - per the plan's "predefined nudges" framing throughout
// docs/V2_Implementation_Plan.md and docs/Draft1_Architecture_Overview.md.
//
// Tone is deliberately encouraging and non-punitive - this product's stated tone is "consensual
// peer pressure, not guilt" (docs/Draft1_Architecture_Overview.md), never scold-y, even though a
// nudge is very likely to arrive while the recipient is mid-distraction (that's exactly when a
// friend would send one). Contrast with pressureEngine.ts's pickWarningMessage: that pool is the
// *system's own voice* escalating at the session owner about their own distraction (and does get
// firmer at higher intervention levels); this catalog is always a friend's voice reaching out,
// and stays warm regardless of how many nudges have already been sent.
//
// Single source of truth: both nudgeApi.ts (server-round-trip-avoiding client-side validation -
// see its own comment on why that check isn't a security boundary) and
// sidepanel/components/FriendGroupPanel.tsx (the message picker UI) import this same list, so the
// catalog only needs to be defined once.
export interface NudgeMessage {
  id: string;
  text: string;
}

export const NUDGE_MESSAGES: readonly NudgeMessage[] = [
  { id: "keep-going", text: "Thinking of you — keep going!" },
  { id: "you-got-this", text: "You've got this." },
  { id: "proud-of-you", text: "Proud of you for showing up today." },
  { id: "small-steps", text: "Every small step counts. Keep it up." },
  { id: "checking-in", text: "Just checking in. Here for you." },
  { id: "almost-there", text: "You're closer than you think. Keep pushing." },
];

const NUDGE_MESSAGE_IDS = new Set(NUDGE_MESSAGES.map((m) => m.id));

export function isValidNudgeMessageId(messageId: string): boolean {
  return NUDGE_MESSAGE_IDS.has(messageId);
}

// Falls back to null (never throws) for an unrecognized id - defensive against a future skew
// between the catalog a client shipped with and the messageId a nudge row actually carries (e.g.
// an old nudge sent before this catalog changes), not expected to happen today since sendNudge()
// only ever inserts a validated id.
export function nudgeMessageText(messageId: string): string | null {
  return NUDGE_MESSAGES.find((m) => m.id === messageId)?.text ?? null;
}
