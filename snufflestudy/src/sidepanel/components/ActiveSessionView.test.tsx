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

// ActiveSessionView only owns the goal/timer/controls/restricted-sites UI. Study Room
// participation and friend-request approval are rendered by the persistent footers instead,
// not by this component.
describe("ActiveSessionView", () => {
  it("renders the goal, timer, pause/end controls, and restricted sites", async () => {
    render(<ActiveSessionView session={mockSession} />);

    // Goal is shown twice by design: once as this screen's own headline, and once inside the
    // reused, unmodified SessionStatusCard (which renders session.goal itself). See
    // ActiveSessionView.tsx for the full comment on this intentional duplication.
    expect(screen.getAllByText("Finish essay").length).toBe(2);

    expect(screen.getByRole("timer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^end session$/i })).toBeInTheDocument();

    expect(screen.getByText("distracting.example")).toBeInTheDocument();

    // No "Friend requests" escape hatch - that content is always visible in the persistent
    // footer instead.
    expect(
      screen.queryByRole("button", { name: /friend requests/i })
    ).not.toBeInTheDocument();
  });
});
