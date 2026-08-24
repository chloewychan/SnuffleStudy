import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { FriendsTab } from "./FriendsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("FriendsTab", () => {
  it("renders StudyRoomPanel, FriendGroupPanel, TempPasscodePanel, UnlockRequestPanel, and SessionEndRequestPanel, in that order", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      members: [],
      rooms: [],
      requests: [],
    });

    render(<FriendsTab />);

    // Structural check: five top-level sections directly under .sp-friends-tab - the original two
    // (StudyRoomPanel, FriendGroupPanel) plus TempPasscodePanel/UnlockRequestPanel (v3.3 Task 1)
    // plus SessionEndRequestPanel (v3.3 Task 12, composed in below the panels Task 1 moved here,
    // per Task 12's Deliverables).
    const sections = document.querySelectorAll(".sp-friends-tab > section");
    expect(sections.length).toBe(5);

    // Substantive check (beyond a bare mount-without-throwing smoke test): each section actually
    // renders its own panel's real heading text (read from source - StudyRoomPanel.tsx's idle-view
    // <h2>Study Rooms</h2>, FriendGroupPanel.tsx's <h2>Friend activity</h2>,
    // TempPasscodePanel.tsx's <h2>Temporary passcode requests</h2>, UnlockRequestPanel.tsx's
    // <h2>Unlock requests</h2>, and SessionEndRequestPanel.tsx's <h2>Session-end requests</h2> -
    // not guessed).
    const studyRoomsHeading = within(sections[0] as HTMLElement).getByRole("heading", {
      name: /^study rooms$/i,
    });
    const friendActivityHeading = within(sections[1] as HTMLElement).getByRole("heading", {
      name: /^friend activity$/i,
    });
    const tempPasscodeHeading = within(sections[2] as HTMLElement).getByRole("heading", {
      name: /^temporary passcode requests$/i,
    });
    const unlockRequestsHeading = within(sections[3] as HTMLElement).getByRole("heading", {
      name: /^unlock requests$/i,
    });
    const sessionEndRequestsHeading = within(sections[4] as HTMLElement).getByRole("heading", {
      name: /^session-end requests$/i,
    });
    expect(studyRoomsHeading).toBeInTheDocument();
    expect(friendActivityHeading).toBeInTheDocument();
    expect(tempPasscodeHeading).toBeInTheDocument();
    expect(unlockRequestsHeading).toBeInTheDocument();
    expect(sessionEndRequestsHeading).toBeInTheDocument();

    // Confirms session={null} was actually wired through to UnlockRequestPanel (same as
    // SettingsTab.tsx passed before v3.3 Task 1 moved it here): with session=null,
    // UnlockRequestPanel's "Request an unlock" section (only rendered when isSessionActive, which
    // requires a non-null session) must be absent - only the "Requests from friends" approver
    // section should render.
    expect(
      within(sections[3] as HTMLElement).queryByRole("heading", { name: /request an unlock/i })
    ).not.toBeInTheDocument();
    expect(
      within(sections[3] as HTMLElement).getByRole("heading", { name: /requests from friends/i })
    ).toBeInTheDocument();

    // All five composed panels fire their own real on-mount fetches rather than being stubbed out
    // - confirms this is a genuine composition, not components that happen to render static markup.
    // Waiting for these also lets the panels' async state updates settle before the test ends,
    // avoiding act() warnings from updates that land after the assertions above.
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith({ type: "STUDY_ROOM_LIST" })
    );
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "FRIEND_EVENTS_FETCH" })
      )
    );
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "TEMP_PASSCODE_REQUESTS_FETCH" })
      )
    );
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "UNLOCK_REQUESTS_FETCH" })
      )
    );
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SESSION_END_REQUESTS_FETCH" })
      )
    );
  });

  it("does not crash when the friends/rooms/requests fetches fail", async () => {
    // Every panel independently handles its own fetch failures (their own test suites cover the
    // exact error copy) - this only confirms composing them doesn't introduce a new failure mode,
    // e.g. an unhandled rejection or a thrown error, when every underlying call rejects.
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<FriendsTab />);

    await waitFor(() => {
      expect(screen.getByText(/could not load rooms/i)).toBeInTheDocument();
      expect(screen.getByText(/couldn't load friend activity/i)).toBeInTheDocument();
      expect(screen.getByText(/couldn't load requests: network down/i)).toBeInTheDocument();
      expect(
        screen.getByText(/couldn't load unlock requests: network down/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/couldn't load session-end requests: network down/i)
      ).toBeInTheDocument();
    });
  });
});
