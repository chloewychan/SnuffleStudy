import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ActiveSessionView } from "./ActiveSessionView";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { StudySession } from "../../domain/session/sessionTypes";

// v3.4 Task 2: friendshipApi.listMyFriends()/FRIENDS_LIST returns a flat string[] of friend user
// ids (no groupId/joinedAt fields - the group mechanic is gone) - no displayName field exists
// anywhere in this schema either, so members are still identified by raw user id.
// FriendGroupPanel.tsx/DigestCard/IncomingNudgeCard all render raw user ids for the same reason -
// this fixture and the assertions below follow that same established, real shape.
const mockMemberId = "u2";

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
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, friendIds: [mockMemberId] });

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
      type: "FRIENDS_LIST",
    });
  });

  it("sends a nudge to the selected friend", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, friendIds: [mockMemberId] });

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
      if (message.type === "FRIENDS_LIST") {
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
      if (message.type === "FRIENDS_LIST") return { ok: true, friendIds: [mockMemberId] };
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
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, friendIds: [] });
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
    // FRIENDS_LIST returns every friend, including the current user's own id if it were ever
    // present - AUTH_GET_SESSION resolves who that is, and the self row must be filtered out of
    // the rendered/nudge-able list, while other friends still render normally.
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_GET_SESSION") {
        return { ok: true, session: { user: { id: "self-1" } } };
      }
      if (message.type === "FRIENDS_LIST") {
        return { ok: true, friendIds: ["self-1", mockMemberId] };
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
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, friendIds: [mockMemberId] });
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
      expect.objectContaining({ type: "FRIENDS_LIST" })
    );
  });
});
