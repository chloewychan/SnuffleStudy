import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FriendsPage } from "./FriendsPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { FriendshipSettings } from "../../infrastructure/backend/friendshipSettingsApi";
import type { ExtensionMessage } from "../../shared/messages";

beforeEach(() => {
  vi.restoreAllMocks();
});

// Mirrors FriendGroupPanel.test.tsx's routeSendMessage helper (same rationale: this page fires
// several independent sendMessage calls on mount - AUTH_GET_SESSION, FRIENDS_LIST,
// FRIENDSHIP_SETTINGS_LIST - a single blanket mockResolvedValue can't give each a different
// shape).
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
    // Two nudge toggles.
    expect(screen.getByLabelText("I may send this friend a live nudge")).toBeChecked();
    expect(screen.getByLabelText("This friend may send me a live nudge")).toBeChecked();
    // The daily-digest checkbox is not rendered here, even though
    // FriendshipSettings.receiveDailyDigest still exists server-side - it's just not surfaced
    // on this page.
    expect(
      screen.queryByLabelText("Receive a daily digest about this friend")
    ).not.toBeInTheDocument();
    // Five sharing toggles, all off by default (most-private-by-default).
    expect(screen.getByLabelText("Share my distraction attempts with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my current site with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my session goal text with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my intervention count with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my full session history with this friend")).not.toBeChecked();
    // FriendSettingsFields always renders a "Remove friend" button, even on this standalone
    // full-page caller.
    expect(screen.getByRole("button", { name: "Remove friend" })).toBeInTheDocument();
  });

  // "Remove friend" is triggerable from wherever a friend's settings render (via
  // FriendSettingsFields + this page's own handleRemove), not just AccountPage.tsx - see
  // FriendsBox.tsx, the sidepanel's home for bulk friend management.
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
