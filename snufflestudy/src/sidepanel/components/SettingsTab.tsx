import { UnlockRequestPanel } from "./UnlockRequestPanel";
import { TempPasscodePanel } from "./TempPasscodePanel";

// Task 8: composes two already-tested, previously-routed panels, following the same "always both
// visible, no navigation" pattern StudyTab.tsx (Task 6) and FriendsTab.tsx (Task 7) established.
// Neither UnlockRequestPanel nor TempPasscodePanel is modified here.
//
// session={null} is passed to UnlockRequestPanel deliberately, not as a placeholder: verified
// against UnlockRequestPanel.tsx's own source (its "Request an unlock" section only renders when
// `session !== null` - see its `isSessionActive` check) and against SidePanelApp.tsx's own
// `view === "unlockRequests"` call site (SidePanelApp.tsx:137), which already passes `session={
// null}` from its no-active-session setup view. With session=null, only the "Requests from
// friends" approver section renders - exactly the brief's premise, confirmed before implementing
// rather than assumed.
//
// Order (TempPasscodePanel first, then UnlockRequestPanel) was verified via get_design_context on
// nodeId=61:923, fileKey=oHeHSnxarHnN0Ly5wAsNnS (Task 8 brief's Step 1) rather than assumed - the
// design's single "Passcode Requests" card shows a "Temporary Requests" sub-section (y=507) above
// an "Unlock Requests" sub-section (y=621). This is the OPPOSITE order from the brief's own literal
// Step 4 code sample (UnlockRequestPanel before TempPasscodePanel) - same category of discrepancy
// as Task 7 found for FriendsTab, and fixed the same way (verified design order used, since doing
// so is entirely within this file's scope - no changes to either composed component). Flagged in
// the task report.
//
// Per the brief's own Step 1 instruction: the design's sub-section labels ("Temporary Requests",
// "Unlock Requests") do NOT match either panel's own internal headings (TempPasscodePanel renders
// <h2>Temporary passcode requests</h2> with an internal <h3>Requests from friends</h3>;
// UnlockRequestPanel renders <h2>Unlock requests</h2> with an internal <h3>Requests from
// friends</h3>). Per the brief, that's just this card's own copy, not something to force-rename
// inside the reused components - left as-is.
//
// Both onClose props are no-ops for the same reason as Task 6/7's precedent: these were
// originally routed pages with a back/close button, now permanently embedded with nowhere to
// "close" to. Both panels do render a visible "Close" button tied to onClose that will visibly do
// nothing when clicked - a known, accepted leftover, not something to fix by modifying the reused
// components.
export function SettingsTab() {
  return (
    <div className="sp-tab-content sp-settings-tab">
      <section className="sp-card">
        <TempPasscodePanel onClose={() => {}} />
      </section>
      <section className="sp-card">
        <UnlockRequestPanel session={null} onClose={() => {}} />
      </section>
    </div>
  );
}
