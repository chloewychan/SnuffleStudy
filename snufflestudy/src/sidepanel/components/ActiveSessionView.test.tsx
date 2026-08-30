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
// toggle (see SidePanelApp.test.tsx for the replacement coverage of RequestUnlockForm rendering
// directly in the active-session view).
//
// v4.2 Task 7: re-skinned as frontend-backup's ActiveStudySessionPage.tsx/ActiveSession.tsx
// design. The goal is now shown once (not twice) - the old duplication came from also embedding
// the whole SessionStatusCard component (which renders session.goal itself a second time); the
// new design's "Activity Status"/"Focus Status" rows are built directly from
// SessionStatusCard.tsx's own exported ACTIVITY_LABELS/DISTRACTION_LABELS instead of embedding
// that component, so there's no second goal render left to assert on.
describe("ActiveSessionView", () => {
  it("renders the goal once, a ticking timer, pause/end controls, activity/focus labels, and restricted sites", async () => {
    render(<ActiveSessionView session={mockSession} />);

    expect(screen.getByText("Finish essay")).toBeInTheDocument();

    expect(screen.getByRole("timer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^end session$/i })).toBeInTheDocument();

    // Activity Status/Focus Status rows bind to session.activityState/interventionLevel exactly
    // as SessionStatusCard.tsx's own ACTIVITY_LABELS/DISTRACTION_LABELS compute them - mockSession
    // is activityState: "active" / interventionLevel: "none" -> "Active" / "On track".
    expect(screen.getByText("Activity Status: Active")).toBeInTheDocument();
    expect(screen.getByText("Focus Status: On track")).toBeInTheDocument();

    // restricted-sites list preserved from the original inline SidePanelApp.tsx active-session
    // branch (lift-and-adapt, not part of the design's own trimmed markup).
    expect(screen.getByText("distracting.example")).toBeInTheDocument();

    // No "Friend requests" escape hatch remains (Task 8) - the approver-side content it used to
    // reveal is now always visible in the persistent footer instead.
    expect(
      screen.queryByRole("button", { name: /friend requests/i })
    ).not.toBeInTheDocument();
  });

  it("reflects a different activityState/interventionLevel independently", () => {
    render(
      <ActiveSessionView
        session={{ ...mockSession, activityState: "idle", interventionLevel: "escalated" }}
      />
    );

    expect(screen.getByText("Activity Status: Idle")).toBeInTheDocument();
    expect(screen.getByText("Focus Status: Escalated")).toBeInTheDocument();
  });
});
