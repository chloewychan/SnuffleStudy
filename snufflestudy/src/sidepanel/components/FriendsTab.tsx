import { FriendGroupPanel } from "./FriendGroupPanel";
import { StudyRoomPanel } from "./StudyRoomPanel";
import { FriendRequestPanel } from "./FriendRequestPanel";

// Task 7: composes two already-tested, previously-routed panels side by side, following the same
// "always both visible, no navigation" pattern StudyTab.tsx (Task 6) established for
// SessionSetupForm/TaskVaultPage. Neither FriendGroupPanel nor StudyRoomPanel is modified here.
//
// Order (StudyRoomPanel first, then FriendGroupPanel) was verified via get_design_context on
// nodeId=58:471, fileKey=oHeHSnxarHnN0Ly5wAsNnS (Task 7 brief's Step 1) rather than assumed - the
// design's actual y-coordinates put the "Study Rooms" card at y=418, the "Friends" card at y=985,
// and the "Producer Tags" card (visually separate in Figma, but already rendered as
// FriendGroupPanel's own last section - see that component's own comments) at y=1487. This is the
// OPPOSITE order from the brief's own "Friends list, then Study Rooms, then Producer Tags" prose
// and its literal Step 4 code sample (FriendGroupPanel before StudyRoomPanel) - flagged in the
// task report; the verified design order was used since fixing it is entirely within this file's
// scope (no changes to either composed component required).
//
// v3.4 Task 4: neither onClose is passed anymore - these were originally routed pages with a
// back button, now permanently embedded side by side in a tab with nowhere to "close" to. Rather
// than the previous no-op onClose={() => {}} (which rendered a visible "Close" button that did
// nothing when clicked), StudyRoomPanel/FriendGroupPanel now treat onClose as optional and only
// render their Close button when a real handler is passed - so simply omitting it here removes
// the dead button entirely instead of leaving a fake one in place.
//
// v3.4 Task 3: TempPasscodePanel/UnlockRequestPanel/SessionEndRequestPanel (which moved here in
// v3.3 Task 1/Task 12, below the existing two panels) are replaced by one FriendRequestPanel,
// mounted in the same spot. No `session` prop needed anymore, unlike the old
// `UnlockRequestPanel session={null}` usage - this tab has no notion of an "active session" to
// request an unlock for, and FriendRequestPanel.tsx is approver-only by design now (Decision 5,
// docs/implementation_plans/V3.4_Implementation_Plan.md - the requester-side "request an unlock"
// section lives in the new, session-aware RequestUnlockForm.tsx instead, composed only at
// SidePanelApp.tsx's active-session call site, not here). No onClose passed - Task 4's "no dead
// button in the first place" design (FriendRequestPanel.tsx's Close button only renders when a
// real handler is passed), unlike the no-op onClose the three panels this replaces each carried.
export function FriendsTab() {
  return (
    <div className="sp-tab-content sp-friends-tab">
      <section className="sp-card">
        <StudyRoomPanel />
      </section>
      <section className="sp-card">
        <FriendGroupPanel />
      </section>
      <section className="sp-card">
        <FriendRequestPanel />
      </section>
    </div>
  );
}
