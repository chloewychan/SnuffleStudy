import { FriendGroupPanel } from "./FriendGroupPanel";

// Task 7: composes an already-tested, previously-routed panel, following the same "always
// visible, no navigation" pattern StudyTab.tsx (Task 6) established for
// SessionSetupForm/TaskVaultPage.
//
// v4.1 Task 7: StudyRoomPanel is no longer mounted here at all - it's been split into
// StudyRoomsBox.tsx (moved to StudyTab.tsx) and the persistent StudyRoomFooter.tsx (mounted via
// AppFooter.tsx at the app-shell level), per the scope doc's "Move the Study Rooms box in from the
// Friends tab" / "Remove the Study Rooms box from this tab (now on Study)".
//
// v4.1 Task 8: the old standalone "Friend requests" panel that used to be mounted here is deleted
// - its approver-side content is now always visible in the new, persistent Nudges & Unlock
// Requests footer (NudgesAndRequestsFooter.tsx, mounted via AppFooter.tsx), not something to
// reveal on this tab. No replacement mount here - see
// docs/scope_summaries/V4.1_Scope_Summary.md's "Remove the standalone Friend requests box" and
// this task's own report for the full relocation.
//
// v3.4 Task 4: FriendGroupPanel's onClose is not passed - this was originally a routed page with a
// back button, now permanently embedded here with nowhere to "close" to. Rather than a no-op
// onClose={() => {}} (which rendered a visible "Close" button that did nothing when clicked),
// FriendGroupPanel treats onClose as optional and only renders its Close button when a real
// handler is passed - so simply omitting it here removes the dead button entirely instead of
// leaving a fake one in place.
export function FriendsTab() {
  return (
    <div className="sp-tab-content sp-friends-tab">
      <section className="sp-card">
        <FriendGroupPanel />
      </section>
    </div>
  );
}
