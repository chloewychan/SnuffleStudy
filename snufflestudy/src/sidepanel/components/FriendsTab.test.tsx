import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { FriendsTab } from "./FriendsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("FriendsTab", () => {
  // v3.4 Task 3: TempPasscodePanel/UnlockRequestPanel/SessionEndRequestPanel (v3.3 Task 1/Task
  // 12) are replaced by one FriendRequestPanel, mounted in the same spot below StudyRoomPanel/
  // FriendGroupPanel - three sections now, not five.
  it("renders StudyRoomPanel, FriendGroupPanel, and FriendRequestPanel, in that order", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      members: [],
      rooms: [],
      requests: [],
    });

    render(<FriendsTab />);

    // Structural check: three top-level sections directly under .sp-friends-tab.
    const sections = document.querySelectorAll(".sp-friends-tab > section");
    expect(sections.length).toBe(3);

    // Substantive check (beyond a bare mount-without-throwing smoke test): each section actually
    // renders its own panel's real heading text (read from source - StudyRoomPanel.tsx's idle-view
    // <h2>Study Rooms</h2>, FriendGroupPanel.tsx's <h2>Friend activity</h2>,
    // FriendRequestPanel.tsx's <h2>Friend requests</h2> - not guessed).
    const studyRoomsHeading = within(sections[0] as HTMLElement).getByRole("heading", {
      name: /^study rooms$/i,
    });
    const friendActivityHeading = within(sections[1] as HTMLElement).getByRole("heading", {
      name: /^friend activity$/i,
    });
    const friendRequestsHeading = within(sections[2] as HTMLElement).getByRole("heading", {
      name: /^friend requests$/i,
    });
    expect(studyRoomsHeading).toBeInTheDocument();
    expect(friendActivityHeading).toBeInTheDocument();
    expect(friendRequestsHeading).toBeInTheDocument();

    // FriendRequestPanel.tsx has no `session` prop anymore (Decision 5 - it's approver-only by
    // design now, not gated on session=null the way UnlockRequestPanel used to be) - only the
    // "Requests from friends" approver section should render.
    expect(
      within(sections[2] as HTMLElement).queryByRole("heading", { name: /request an unlock/i })
    ).not.toBeInTheDocument();
    expect(
      within(sections[2] as HTMLElement).getByRole("heading", { name: /requests from friends/i })
    ).toBeInTheDocument();

    // No Close button anywhere - v3.4 Task 4: StudyRoomPanel/FriendGroupPanel's onClose is now
    // optional (rendered only when a real handler is passed), and this component no longer
    // passes a no-op to either. FriendRequestPanel.tsx (Task 3) never had one to begin with -
    // "no dead button in the first place" design.
    expect(
      within(sections[0] as HTMLElement).queryByRole("button", { name: /close/i })
    ).not.toBeInTheDocument();
    expect(
      within(sections[1] as HTMLElement).queryByRole("button", { name: /close/i })
    ).not.toBeInTheDocument();
    expect(
      within(sections[2] as HTMLElement).queryByRole("button", { name: /close/i })
    ).not.toBeInTheDocument();

    // All three composed panels fire their own real on-mount fetches rather than being stubbed
    // out - confirms this is a genuine composition, not components that happen to render static
    // markup. Waiting for these also lets the panels' async state updates settle before the test
    // ends, avoiding act() warnings from updates that land after the assertions above.
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
        expect.objectContaining({ type: "FRIEND_REQUESTS_FETCH" })
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
      expect(
        screen.getByText(/couldn't load friend requests: network down/i)
      ).toBeInTheDocument();
    });
  });
});
