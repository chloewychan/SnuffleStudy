import { FriendGroupPanel } from "./FriendGroupPanel";
import { FriendRequestPanel } from "./FriendRequestPanel";

// Task 7: composes two already-tested, previously-routed panels side by side, following the same
// "always both visible, no navigation" pattern StudyTab.tsx (Task 6) established for
// SessionSetupForm/TaskVaultPage.
//
// v4.1 Task 7: StudyRoomPanel is no longer mounted here at all - it's been split into
// StudyRoomsBox.tsx (moved to StudyTab.tsx) and the persistent StudyRoomFooter.tsx (mounted via
// AppFooter.tsx at the app-shell level), per the scope doc's "Move the Study Rooms box in from the
// Friends tab" / "Remove the Study Rooms box from this tab (now on Study)".
//
// v3.4 Task 4: FriendGroupPanel's onClose is not passed - this was originally a routed page with a
// back button, now permanently embedded here with nowhere to "close" to. Rather than a no-op
// onClose={() => {}} (which rendered a visible "Close" button that did nothing when clicked),
// FriendGroupPanel treats onClose as optional and only renders its Close button when a real
// handler is passed - so simply omitting it here removes the dead button entirely instead of
// leaving a fake one in place.
//
// v3.4 Task 3: TempPasscodePanel/UnlockRequestPanel/SessionEndRequestPanel (which moved here in
// v3.3 Task 1/Task 12) are replaced by one FriendRequestPanel, mounted in the same spot. No
// `session` prop needed anymore, unlike the old `UnlockRequestPanel session={null}` usage - this
// tab has no notion of an "active session" to request an unlock for, and FriendRequestPanel.tsx is
// approver-only by design now (Decision 5, docs/implementation_plans/V3.4_Implementation_Plan.md -
// the requester-side "request an unlock" section lives in the new, session-aware
// RequestUnlockForm.tsx instead, composed only at SidePanelApp.tsx's active-session call site, not
// here). No onClose passed - Task 4's "no dead button in the first place" design
// (FriendRequestPanel.tsx's Close button only renders when a real handler is passed).
export function FriendsTab() {
  return (
    <div className="sp-tab-content sp-friends-tab">
      <section className="sp-card">
        <FriendGroupPanel />
      </section>
      <section className="sp-card">
        <FriendRequestPanel />
      </section>
    </div>
  );
}
