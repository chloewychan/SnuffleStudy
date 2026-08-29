import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActiveSessionView } from "./ActiveSessionView";
import type { StudySession } from "../../domain/session/sessionTypes";

const mockSession: StudySession = {
  id: "s1",
  goal: "Finish essay",
  state: "FOCUSING",
  interventionLevel: "none",
  activityState: "active",
  createdAt: 0,
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  remainingSeconds: 900,
  pressureProfileId: "p1",
  allowedSites: [],
  restrictedSites: ["distracting.example"],
  restrictionMode: "soft",
  accountabilityGroupId: "g1",
  accountabilityUserIds: ["u2"],
  distractionAttempts: 0,
  recoveries: 0,
  friendNudges: 0,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// v4.1 Task 7 (Decision 4): this file's own "Study Room" section (member list + per-member Nudge
// button, gated on session.accountabilityGroupId) was removed entirely - it was already confirmed
// dead code (accountabilityGroupId has no producer anywhere in the codebase, so that branch never
// rendered), and duplicated what the new, real, persistent Study Room footer
// (StudyRoomFooter.tsx/AppFooter.tsx) now provides. Every test that exercised that section
// (members fetch, per-member nudge, the self-filter, the "no accountabilityGroupId" guard) is
// removed along with it, not left failing.
//
// v4.1 Task 8: the "Friend requests" escape-hatch button (and the reveal-callback prop it used to
// take) is removed too - the standalone approver-side panel it used to reveal is now always
// visible in the new persistent Nudges & Unlock Requests footer instead of behind this button's
// toggle (see
// SidePanelApp.test.tsx for the replacement coverage of RequestUnlockForm rendering directly in
// the active-session view). Only the goal/timer/controls/restricted-sites coverage below remains,
// since that's all this component still owns.
describe("ActiveSessionView", () => {
  it("renders the goal, timer, pause/end controls, and restricted sites", async () => {
    render(<ActiveSessionView session={mockSession} />);

    // Goal is shown twice by design: once as this screen's own headline (Figma node 60:783,
    // positioned above the "Study Session in Progress" card) and once inside the reused,
    // unmodified SessionStatusCard (which renders session.goal itself). See ActiveSessionView.tsx
    // for the full comment on this intentional duplication.
    expect(screen.getAllByText("Finish essay").length).toBe(2);

    expect(screen.getByRole("timer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^end session$/i })).toBeInTheDocument();

    // restricted-sites list preserved from the original inline SidePanelApp.tsx active-session
    // branch (lift-and-adapt, not part of the Figma mock's trimmed metadata).
    expect(screen.getByText("distracting.example")).toBeInTheDocument();

    // No "Friend requests" escape hatch remains (Task 8) - the approver-side content it used to
    // reveal is now always visible in the persistent footer instead.
    expect(
      screen.queryByRole("button", { name: /friend requests/i })
    ).not.toBeInTheDocument();
  });
});
