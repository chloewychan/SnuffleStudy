import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ActiveSessionView } from "./ActiveSessionView";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { StudySession } from "../../domain/session/sessionTypes";
import type { GroupMembership } from "../../infrastructure/backend/friendGroupApi";

// GroupMembership (src/infrastructure/backend/friendGroupApi.ts) is { groupId, userId, joinedAt }
// - no displayName field exists anywhere in this schema (that file's own listMembers() comment:
// "There is no `profiles` table in this schema... member identity here is limited to whatever
// group_memberships itself has, i.e. raw user_ids"). FriendGroupPanel.tsx/DigestCard/
// IncomingNudgeCard all render raw user ids for the same reason - this fixture and the assertions
// below follow that same established, real shape rather than a guessed displayName field.
const mockMember: GroupMembership = { userId: "u2", groupId: "g1", joinedAt: "2026-01-01T00:00:00Z" };

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

describe("ActiveSessionView", () => {
  it("renders the goal, timer, pause/end controls, restricted sites, and study room members", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, members: [mockMember] });

    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
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

    expect(await screen.findByText("Friend u2")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /nudge u2/i })).toBeInTheDocument();

    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "GROUP_LIST_MEMBERS",
      payload: { groupId: "g1" },
    });
  });

  it("sends a nudge to the selected friend", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, members: [mockMember] });

    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
    );

    const nudgeButton = await screen.findByRole("button", { name: /nudge u2/i });
    nudgeButton.click();

    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "NUDGE_SEND",
          payload: expect.objectContaining({ friendUserId: "u2" }),
        })
      )
    );
  });

  it("surfaces an error instead of crashing when the study room members fetch fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "GROUP_LIST_MEMBERS") {
        throw new Error("network down");
      }
      return { ok: true };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
    );

    expect(await screen.findByText(/couldn't load your study room/i)).toBeInTheDocument();
  });

  it("reports a server-side nudge rejection instead of silently swallowing it", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "GROUP_LIST_MEMBERS") return { ok: true, members: [mockMember] };
      if (message.type === "NUDGE_SEND") return { ok: false, error: "Nudge cooldown active." };
      return { ok: true };
    });

    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
    );

    const nudgeButton = await screen.findByRole("button", { name: /nudge u2/i });
    nudgeButton.click();

    expect(await screen.findByText(/nudge cooldown active/i)).toBeInTheDocument();
  });

  it("calls onShowUnlockPanel/onShowTempPasscodePanel from their trigger buttons, without rendering the panels itself", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, members: [] });
    const onShowUnlockPanel = vi.fn();
    const onShowTempPasscodePanel = vi.fn();

    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={onShowUnlockPanel}
        onShowTempPasscodePanel={onShowTempPasscodePanel}
      />
    );

    screen.getByRole("button", { name: /unlock/i }).click();
    screen.getByRole("button", { name: /temp passcode/i }).click();

    expect(onShowUnlockPanel).toHaveBeenCalledTimes(1);
    expect(onShowTempPasscodePanel).toHaveBeenCalledTimes(1);
    // Actual panel mounting stays SidePanelApp.tsx's job (Task 10) - this component only renders
    // the two trigger buttons, per the brief's Interfaces:Produces note.
    expect(screen.queryByText(/request an unlock/i)).not.toBeInTheDocument();
  });

  it("does not list the current user as their own nudge target (Fix 4)", async () => {
    // GROUP_LIST_MEMBERS returns every member of the group, including the current user
    // themselves - AUTH_GET_SESSION resolves who that is, and the self row must be filtered out
    // of the rendered/nudge-able list, while other friends still render normally.
    const selfMember: GroupMembership = {
      userId: "self-1",
      groupId: "g1",
      joinedAt: "2026-01-01T00:00:00Z",
    };
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_GET_SESSION") {
        return { ok: true, session: { user: { id: "self-1" } } };
      }
      if (message.type === "GROUP_LIST_MEMBERS") {
        return { ok: true, members: [selfMember, mockMember] };
      }
      return { ok: true };
    });

    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
    );

    // The other friend (u2) still renders as a nudge target.
    expect(await screen.findByRole("button", { name: /nudge u2/i })).toBeInTheDocument();
    // The current user's own id never appears as a nudge target.
    expect(screen.queryByText(/friend self-1/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /nudge self-1/i })
    ).not.toBeInTheDocument();
  });

  it("does not fetch study room members when the session has no accountabilityGroupId", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, members: [mockMember] });
    const { accountabilityGroupId, ...rest } = mockSession;
    const sessionWithoutGroup: StudySession = { ...rest };

    render(
      <ActiveSessionView
        session={sessionWithoutGroup}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
    );

    await screen.findAllByText("Finish essay");
    expect(messenger.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "GROUP_LIST_MEMBERS" })
    );
  });
});
