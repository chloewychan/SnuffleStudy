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
  nudgeCooldownSeconds: 300,
  shareDistractionAttempts: false,
  shareCurrentDomain: false,
  shareGoalText: false,
  shareInterventionCount: false,
  shareFullHistory: false,
};

describe("FriendsPage", () => {
  it("lists a friend (discovered via FRIENDS_LIST) with their settings row's checkboxes", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendsPage />);

    expect(await screen.findByText("user-friend")).toBeInTheDocument();
    // Three pre-existing (Task 5/7) toggles.
    expect(screen.getByLabelText("I may send this friend a live nudge")).toBeChecked();
    expect(screen.getByLabelText("This friend may send me a live nudge")).toBeChecked();
    expect(screen.getByLabelText("Receive a daily digest about this friend")).toBeChecked();
    // Five new (Task 10) toggles, all off by default per the migration's "most-private-by-
    // default" column defaults.
    expect(screen.getByLabelText("Share my distraction attempts with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my current site with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my session goal text with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my intervention count with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my full session history with this friend")).not.toBeChecked();
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
