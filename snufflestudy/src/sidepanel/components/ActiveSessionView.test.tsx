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
// removed along with it, not left failing - only the goal/timer/controls/restricted-sites/
// escape-hatch coverage below remains, since that's all this component still owns.
describe("ActiveSessionView", () => {
  it("renders the goal, timer, pause/end controls, and restricted sites", async () => {
    render(
      <ActiveSessionView session={mockSession} onShowFriendRequestPanel={vi.fn()} />
    );

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
  });

  // v3.4 Task 3: the two separate onShowUnlockPanel/onShowTempPasscodePanel trigger buttons
  // collapse into one onShowFriendRequestPanel button, now that unlock_requests/
  // temp_passcode_requests/session_end_requests are one friend_requests table behind one panel.
  it("calls onShowFriendRequestPanel from its trigger button, without rendering the panel itself", async () => {
    const onShowFriendRequestPanel = vi.fn();

    render(
      <ActiveSessionView session={mockSession} onShowFriendRequestPanel={onShowFriendRequestPanel} />
    );

    screen.getByRole("button", { name: /friend requests/i }).click();

    expect(onShowFriendRequestPanel).toHaveBeenCalledTimes(1);
    // Actual panel mounting stays SidePanelApp.tsx's job - this component only renders the
    // trigger button, per Decision 5's Interfaces:Produces note.
    expect(screen.queryByText(/request an unlock/i)).not.toBeInTheDocument();
  });
});
