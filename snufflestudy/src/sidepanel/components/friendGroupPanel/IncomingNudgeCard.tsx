import { getAnimationAsset } from "../../../content/overlay/animationRegistry";
import { nudgeMessageText } from "../../../domain/accountability/nudgeMessages";
import type { FriendNudge } from "../../../infrastructure/backend/nudgeApi";

// v2 Task 7 (moved into its own file, v3.2 Task 7 split - no behavior change): renders one
// incoming nudge using the exact same visual pattern v1's SnufflesOverlay warning state uses
// (src/content/overlay/SnufflesOverlay.tsx) - same CSS classes
// ("snuffles-overlay snuffles-overlay--warning", role="alert", src/styles/global.css), same
// Snuffles image-asset mechanism (getAnimationAsset, which resolves via chrome.runtime.getURL -
// works fine in this sidepanel extension page context, not just content scripts). This is
// deliberately not the literal SnufflesOverlay component - that one is tightly coupled to
// site-restriction classification/hostname/sessionId props that don't apply to a friend's nudge -
// but the visual output should look and feel identical, not a new bespoke UI (per that task's
// brief). FriendGroupPanel.tsx only ever passes the single oldest not-yet-dismissed nudge (see
// useFriendGroupPanelData's `visibleNudge`) - mirrors SnufflesOverlay's own "one active warning at
// a time, dismissible" pattern rather than a stacked list, which would also visually collide given
// `.snuffles-overlay`'s `position: fixed`.
export function IncomingNudgeCard({ nudge, onDismiss }: { nudge: FriendNudge; onDismiss: () => void }) {
  const asset = getAnimationAsset("study", "proud");
  const reducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  const imageSrc = reducedMotion ? asset.staticFrame : asset.frames[0];
  // v4.1 Task 1: a nudge is now either catalog-authored (messageId) or vault-authored
  // (customBody, copied in at send time - Decision 1); exactly one is ever set. customBody takes
  // priority when present, since it's already display text needing no catalog lookup.
  const messageText =
    nudge.customBody ?? (nudge.messageId ? nudgeMessageText(nudge.messageId) : null) ?? "sent you a nudge.";

  return (
    <div className="snuffles-overlay snuffles-overlay--warning" role="alert">
      <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      <p>{messageText}</p>
      <p>From friend {nudge.senderUserId}</p>
      <div className="snuffles-overlay__actions">
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
