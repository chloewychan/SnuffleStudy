import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { FriendsTab } from "./FriendsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("FriendsTab", () => {
  // v4.1 Task 7: StudyRoomPanel is no longer mounted here at all (moved to StudyTab.tsx as
  // StudyRoomsBox, with its joined-room view now a persistent app-shell footer).
  // v4.1 Task 8: the old standalone "Friend requests" panel is no longer mounted here at all
  // either (its approver-side content is now always visible in the new Nudges & Unlock Requests
  // footer instead) - only one section remains, down from two.
  it("renders FriendGroupPanel", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      members: [],
      requests: [],
    });

    render(<FriendsTab />);

    // Structural check: one top-level section directly under .sp-friends-tab.
    const sections = document.querySelectorAll(".sp-friends-tab > section");
    expect(sections.length).toBe(1);

    // Substantive check (beyond a bare mount-without-throwing smoke test): the section actually
    // renders FriendGroupPanel.tsx's real heading text (read from source - <h2>Friend
    // activity</h2> - not guessed).
    const friendActivityHeading = within(sections[0] as HTMLElement).getByRole("heading", {
      name: /^friend activity$/i,
    });
    expect(friendActivityHeading).toBeInTheDocument();

    // No Close button - v3.4 Task 4: FriendGroupPanel's onClose is now optional (rendered only
    // when a real handler is passed), and this component no longer passes a no-op.
    expect(
      within(sections[0] as HTMLElement).queryByRole("button", { name: /close/i })
    ).not.toBeInTheDocument();

    // The composed panel fires its own real on-mount fetch rather than being stubbed out -
    // confirms this is a genuine composition, not a component that happens to render static
    // markup. Waiting for this also lets the panel's async state updates settle before the test
    // ends, avoiding act() warnings from updates that land after the assertions above.
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "FRIEND_EVENTS_FETCH" })
      )
    );
  });

  it("does not crash when the friend-activity fetches fail", async () => {
    // FriendGroupPanel independently handles its own fetch failures (its own test suite covers
    // the exact error copy) - this only confirms composing it doesn't introduce a new failure
    // mode, e.g. an unhandled rejection or a thrown error, when every underlying call rejects.
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<FriendsTab />);

    await waitFor(() => {
      expect(screen.getByText(/couldn't load friend activity/i)).toBeInTheDocument();
    });
  });
});
