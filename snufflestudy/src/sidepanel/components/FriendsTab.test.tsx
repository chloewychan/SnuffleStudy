import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { FriendsTab } from "./FriendsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { ExtensionMessage } from "../../shared/messages";

beforeEach(() => {
  vi.restoreAllMocks();
});

type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    FRIENDS_LIST: () => ({ ok: true, friendIds: [] }),
    FRIENDSHIP_SETTINGS_LIST: () => ({ ok: true, settings: [] }),
    STUDY_ROOM_LIST: () => ({ ok: true, rooms: [] }),
    NUDGE_VAULT_TEXT_LIST: () => ({ ok: true, texts: [] }),
    PRODUCER_TAG_LIST_MINE: () => ({ ok: true, tags: [] }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

// v4.1 Task 9: FriendGroupPanel.tsx (and its NudgeSendSection/DigestSection/FriendEventFeed
// children) is deleted - this tab now mounts exactly two boxes, FriendsBox and NudgeVaultBox,
// each its own sp-card, replacing the single "Friend activity" panel this file used to test.
describe("FriendsTab", () => {
  it("renders exactly two cards: Friends and Nudge Vault", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendsTab />);

    const sections = document.querySelectorAll(".sp-friends-tab > section");
    expect(sections.length).toBe(2);

    const friendsHeading = within(sections[0] as HTMLElement).getByRole("heading", {
      name: /^friends$/i,
    });
    expect(friendsHeading).toBeInTheDocument();

    const vaultHeading = within(sections[1] as HTMLElement).getByRole("heading", {
      name: /^nudge vault$/i,
    });
    expect(vaultHeading).toBeInTheDocument();

    // Both boxes fire their own real on-mount fetches rather than being stubbed out - confirms
    // this is a genuine composition, not static markup. Waiting for these also lets async state
    // updates settle before the test ends, avoiding act() warnings.
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "FRIENDS_LIST" })
      )
    );
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "NUDGE_VAULT_TEXT_LIST" })
      )
    );
  });

  it("does not crash when every underlying fetch rejects", async () => {
    // Each box independently handles its own fetch failures (their own test suites cover the
    // exact error copy) - this only confirms composing them doesn't introduce a new failure
    // mode, e.g. an unhandled rejection or a thrown error, when every call rejects.
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<FriendsTab />);

    await waitFor(() => {
      expect(screen.getAllByText(/network down/i).length).toBeGreaterThan(0);
    });
  });
});
