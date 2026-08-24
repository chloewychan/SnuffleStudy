import { FriendGroupPanel } from "./FriendGroupPanel";
import { StudyRoomPanel } from "./StudyRoomPanel";
import { TempPasscodePanel } from "./TempPasscodePanel";
import { UnlockRequestPanel } from "./UnlockRequestPanel";
import { SessionEndRequestPanel } from "./SessionEndRequestPanel";

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
// Both onClose props are no-ops for the same reason as Task 6's TaskVaultPage: these were
// originally routed pages with a back button, now permanently embedded side by side in a tab with
// nowhere to "close" to. Both panels do render a visible "Close" button tied to onClose that will
// visibly do nothing when clicked - a known, accepted leftover (see Task 6 precedent), not
// something to fix by modifying the reused components.
//
// v3.3 Task 1: TempPasscodePanel and UnlockRequestPanel move here from SettingsTab.tsx (which
// Task 7 rebuilds), below the existing two panels, in that order - per the V3.3 Implementation
// Plan's Task 1 Deliverables. session={null} is passed to UnlockRequestPanel for the same reason
// SettingsTab.tsx passed it: this tab has no notion of an "active session" to request an unlock
// for, so only its "Requests from friends" approver section renders. Both onClose props are
// no-ops for the same reason as the two panels above - no "close" destination once embedded.
//
// v3.3 Task 12: SessionEndRequestPanel composed in below the panels Task 1 moved here, per this
// task's Deliverables. Same no-op onClose treatment as every other panel in this tab.
export function FriendsTab() {
  return (
    <div className="sp-tab-content sp-friends-tab">
      <section className="sp-card">
        <StudyRoomPanel onClose={() => {}} />
      </section>
      <section className="sp-card">
        <FriendGroupPanel onClose={() => {}} />
      </section>
      <section className="sp-card">
        <TempPasscodePanel onClose={() => {}} />
      </section>
      <section className="sp-card">
        <UnlockRequestPanel session={null} onClose={() => {}} />
      </section>
      <section className="sp-card">
        <SessionEndRequestPanel onClose={() => {}} />
      </section>
    </div>
  );
}
