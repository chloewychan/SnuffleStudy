import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FriendsPage } from "./FriendsPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { FriendshipSettings } from "../../infrastructure/backend/friendshipSettingsApi";
import type { ExtensionMessage } from "../../shared/messages";

beforeEach(() => {
  vi.restoreAllMocks();
});

// v3.4 Task 2: mirrors FriendGroupPanel.test.tsx's routeSendMessage helper exactly (same
// rationale: this page fires several independent sendMessage calls on mount - AUTH_GET_SESSION,
// FRIENDS_LIST, FRIENDSHIP_SETTINGS_LIST - a single blanket mockResolvedValue can't give each a
// different shape).
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    FRIENDS_LIST: () => ({ ok: true, friendIds: ["user-friend"] }),
    FRIENDSHIP_SETTINGS_LIST: () => ({ ok: true, settings: [sampleSettings] }),
    FRIENDSHIP_SETTINGS_UPDATE: () => ({ ok: true, settings: sampleSettings }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

const sampleSettings: FriendshipSettings = {
  userId: "user-self",
  friendUserId: "user-friend",
  receiveLiveNudges: true,
  sendLiveNudges: true,
  receiveDailyDigest: true,
  nudgeCooldownSecondsWritten: 300,
  nudgeCooldownSecondsAudio: 300,
  shareDistractionAttempts: false,
  shareCurrentDomain: false,
  shareGoalText: false,
  shareInterventionCount: false,
  shareFullHistory: false,
};

describe("FriendsPage", () => {
  it("lists a friend (discovered via FRIENDS_LIST) with their settings row's seven checkboxes (no daily-digest checkbox)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendsPage />);

    expect(await screen.findByText("user-friend")).toBeInTheDocument();
    // Two pre-existing (Task 5/7) nudge toggles.
    expect(screen.getByLabelText("I may send this friend a live nudge")).toBeChecked();
    expect(screen.getByLabelText("This friend may send me a live nudge")).toBeChecked();
    // v4.1 Task 9: the daily-digest checkbox is dropped along with the rest of the digest
    // feature - no longer rendered here, even though FriendshipSettings.receiveDailyDigest
    // still exists server-side (the digest backend itself is out of scope for this release).
    expect(
      screen.queryByLabelText("Receive a daily digest about this friend")
    ).not.toBeInTheDocument();
    // Five new (Task 10) toggles, all off by default per the migration's "most-private-by-
    // default" column defaults.
    expect(screen.getByLabelText("Share my distraction attempts with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my current site with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my session goal text with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my intervention count with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my full session history with this friend")).not.toBeChecked();
    // v4.1 Task 9: FriendSettingsFields also always renders a "Remove friend" button now, even
    // on this standalone full-page caller (previously only AccountPage.tsx's "Your friends" had
    // one).
    expect(screen.getByRole("button", { name: "Remove friend" })).toBeInTheDocument();
  });

  // v4.1 Task 9: "Remove friend" moved here (via the newly-extracted FriendSettingsFields +
  // this page's own new handleRemove) since removal now needs to be triggerable from wherever a
  // friend's settings render, not just AccountPage.tsx (whose "Your friends" section is gone -
  // see FriendsBox.tsx, the new sidepanel home for bulk friend management).
  describe("removing a friend", () => {
    it("removes a friend via FRIEND_REMOVE and drops them from the rendered list", async () => {
      const removeSpy = vi.fn(async () => ({ ok: true }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({ FRIEND_REMOVE: removeSpy })
      );

      render(<FriendsPage />);
      await screen.findByText("user-friend");

      fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));

      await waitFor(() =>
        expect(removeSpy).toHaveBeenCalledWith({
          type: "FRIEND_REMOVE",
          payload: { friendUserId: "user-friend" },
        })
      );
      await waitFor(() => expect(screen.queryByText("user-friend")).not.toBeInTheDocument());
    });

    it("surfaces a server-side denial as an error, without removing the row", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          FRIEND_REMOVE: async () => ({ ok: false, error: "You aren't friends with this user." }),
        })
      );

      render(<FriendsPage />);
      await screen.findByText("user-friend");

      fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /you aren't friends with this user/i
      );
      expect(screen.getByText("user-friend")).toBeInTheDocument();
    });
  });

  it("sends FRIENDSHIP_SETTINGS_UPDATE with only the toggled field when a checkbox is flipped", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIENDSHIP_SETTINGS_UPDATE: () => ({
          ok: true,
          settings: { ...sampleSettings, shareCurrentDomain: true },
        }),
      })
    );

    render(<FriendsPage />);
    await screen.findByText("user-friend");

    fireEvent.click(screen.getByLabelText("Share my current site with this friend"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "FRIENDSHIP_SETTINGS_UPDATE",
        payload: { friendUserId: "user-friend", patch: { shareCurrentDomain: true } },
      })
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Share my current site with this friend")).toBeChecked()
    );
  });

  it("rolls back the optimistic toggle and surfaces an error when the update fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIENDSHIP_SETTINGS_UPDATE: () => ({ ok: false, error: "no shared group" }),
      })
    );

    render(<FriendsPage />);
    await screen.findByText("user-friend");

    fireEvent.click(screen.getByLabelText("Share my current site with this friend"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no shared group/i);
    await waitFor(() =>
      expect(screen.getByLabelText("Share my current site with this friend")).not.toBeChecked()
    );
  });

  it("shows a no-friends message when the user has no friends", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIENDS_LIST: () => ({ ok: true, friendIds: [] }) })
    );

    render(<FriendsPage />);

    expect(await screen.findByText(/no friends yet/i)).toBeInTheDocument();
  });

  it("prompts sign-in when there is no authenticated session", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    render(<FriendsPage />);

    expect(await screen.findByText(/sign in on the account page/i)).toBeInTheDocument();
  });

  it("surfaces an error instead of hanging when the initial fetch rejects", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );

    render(<FriendsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
