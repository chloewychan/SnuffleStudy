import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FriendsBox } from "./FriendsBox";
import { RefreshRegistryProvider, useRefreshAll } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { ExtensionMessage } from "../../shared/messages";
import type { FriendshipSettings } from "../../infrastructure/backend/friendshipSettingsApi";

beforeEach(() => {
  vi.restoreAllMocks();
});

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

const sampleRoom = {
  id: "room-1",
  name: "Thursday study group",
  ownerUserId: "user-self",
  createdAt: "2026-01-01T00:00:00.000Z",
};

type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    FRIENDS_LIST: () => ({ ok: true, friendIds: ["user-friend"] }),
    FRIENDSHIP_SETTINGS_LIST: () => ({ ok: true, settings: [sampleSettings] }),
    FRIENDSHIP_SETTINGS_UPDATE: () => ({ ok: true, settings: sampleSettings }),
    STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }),
    NUDGE_VAULT_TEXT_LIST: () => ({
      ok: true,
      texts: [{ id: "text-1", body: "You've got this!", createdAt: 1000 }],
    }),
    PRODUCER_TAG_LIST_MINE: () => ({ ok: true, tags: [] }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

function renderBox() {
  return render(
    <RefreshRegistryProvider>
      <FriendsBox />
    </RefreshRegistryProvider>
  );
}

async function selectFriend(name: string) {
  const item = (await screen.findByText(name)).closest("li")!;
  fireEvent.click(within(item).getByRole("checkbox"));
  return item;
}

describe("FriendsBox", () => {
  it("lists friends via FRIENDS_LIST with a checkbox per row", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    renderBox();

    expect(await screen.findByText("user-friend")).toBeInTheDocument();
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: "FRIENDS_LIST" });
  });

  it("shows a no-friends message when there are none", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIENDS_LIST: () => ({ ok: true, friendIds: [] }) })
    );

    renderBox();

    expect(await screen.findByText(/no friends yet/i)).toBeInTheDocument();
  });

  it("prompts sign-in when there is no authenticated session", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    renderBox();

    expect(await screen.findByText(/sign in to manage your friends/i)).toBeInTheDocument();
  });

  describe("per-friend Options popover", () => {
    it("opens to show exactly seven checkboxes (no daily-digest) and a working Remove friend button", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

      renderBox();
      await screen.findByText("user-friend");

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      expect(screen.getByLabelText("I may send this friend a live nudge")).toBeChecked();
      expect(screen.getByLabelText("This friend may send me a live nudge")).toBeChecked();
      expect(
        screen.queryByLabelText("Receive a daily digest about this friend")
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Share my distraction attempts with this friend")).not.toBeChecked();
      expect(screen.getByLabelText("Share my current site with this friend")).not.toBeChecked();
      expect(screen.getByLabelText("Share my session goal text with this friend")).not.toBeChecked();
      expect(screen.getByLabelText("Share my intervention count with this friend")).not.toBeChecked();
      expect(screen.getByLabelText("Share my full session history with this friend")).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Remove friend" })).toBeInTheDocument();
    });

    it("removes a friend via FRIEND_REMOVE and drops them from the list", async () => {
      const removeSpy = vi.fn(async () => ({ ok: true }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({ FRIEND_REMOVE: removeSpy })
      );

      renderBox();
      await screen.findByText("user-friend");
      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));

      await waitFor(() =>
        expect(removeSpy).toHaveBeenCalledWith({
          type: "FRIEND_REMOVE",
          payload: { friendUserId: "user-friend" },
        })
      );
      await waitFor(() => expect(screen.queryByText("user-friend")).not.toBeInTheDocument());
    });
  });

  describe("bulk Nudge action", () => {
    it("sends the chosen vault nudge to every selected friend, then clears the selection", async () => {
      const nudgeSpy = vi.fn(async () => ({ ok: true }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({ NUDGE_SEND: nudgeSpy })
      );

      renderBox();
      await selectFriend("user-friend");

      await waitFor(() => expect(screen.getByLabelText("Nudge Vault item")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText("Nudge Vault item"), {
        target: { value: "written:text-1" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^nudge/i }));

      await waitFor(() =>
        expect(nudgeSpy).toHaveBeenCalledWith({
          type: "NUDGE_SEND",
          payload: { friendUserId: "user-friend", vaultTextId: "text-1" },
        })
      );

      // Decision 7's "then deselects them" - the friend checkbox is unchecked again afterward.
      await waitFor(() => {
        const item = screen.getByText("user-friend").closest("li")!;
        expect(within(item).getByRole("checkbox")).not.toBeChecked();
      });
    });

    it("disables the Nudge button until both a friend and a vault item are selected", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

      renderBox();
      await screen.findByText("user-friend");

      expect(screen.getByRole("button", { name: /^nudge/i })).toBeDisabled();
    });
  });

  describe("bulk Add to room action", () => {
    it("adds every selected friend to the chosen room, then clears the selection", async () => {
      const addSpy = vi.fn(async () => ({ ok: true }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({ STUDY_ROOM_INVITEE_ADD: addSpy })
      );

      renderBox();
      await selectFriend("user-friend");

      await waitFor(() => expect(screen.getByLabelText("Study room")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText("Study room"), { target: { value: "room-1" } });
      fireEvent.click(screen.getByRole("button", { name: /^add to room/i }));

      await waitFor(() =>
        expect(addSpy).toHaveBeenCalledWith({
          type: "STUDY_ROOM_INVITEE_ADD",
          payload: { roomId: "room-1", userId: "user-friend" },
        })
      );
      await waitFor(() => {
        const item = screen.getByText("user-friend").closest("li")!;
        expect(within(item).getByRole("checkbox")).not.toBeChecked();
      });
    });
  });

  describe("Invite a friend / Add a friend", () => {
    it("generates an invite code with one click", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          FRIEND_INVITE_GENERATE_CODE: async () => ({
            ok: true,
            inviteCode: {
              code: "ABCD1234",
              createdBy: "user-self",
              expiresAt: new Date("2026-01-08T00:00:00Z").getTime(),
              usedBy: null,
            },
          }),
        })
      );

      renderBox();
      await waitFor(() => screen.getByRole("button", { name: "Invite a friend" }));
      fireEvent.click(screen.getByRole("button", { name: "Invite a friend" }));

      expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
    });

    it("adds a friend by invite code, then reloads the friends list", async () => {
      let friendsListCallCount = 0;
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          FRIENDS_LIST: () => {
            friendsListCallCount += 1;
            return { ok: true, friendIds: friendsListCallCount === 1 ? [] : ["user-new-friend"] };
          },
          FRIEND_REDEEM_CODE: async () => ({ ok: true }),
        })
      );

      renderBox();
      await waitFor(() => screen.getByLabelText("Invite code"));

      fireEvent.change(screen.getByLabelText("Invite code"), { target: { value: "code1234" } });
      fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

      await waitFor(() =>
        expect(messenger.sendMessage).toHaveBeenCalledWith({
          type: "FRIEND_REDEEM_CODE",
          payload: { code: "CODE1234" },
        })
      );
      expect(await screen.findByText("user-new-friend")).toBeInTheDocument();
    });
  });

  it("registers its own refresh with the refresh registry", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    function RefreshButton() {
      const refreshAll = useRefreshAll();
      return (
        <button type="button" onClick={refreshAll}>
          Refresh
        </button>
      );
    }

    render(
      <RefreshRegistryProvider>
        <FriendsBox />
        <RefreshButton />
      </RefreshRegistryProvider>
    );

    await screen.findByText("user-friend");
    sendMessageSpy.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({ type: "FRIENDS_LIST" })
    );
  });
});
