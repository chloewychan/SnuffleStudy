import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FriendGroupPanel } from "./FriendGroupPanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { FriendEvent } from "../../infrastructure/backend/sessionStatusSyncApi";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { ExtensionMessage } from "../../shared/messages";

beforeEach(() => {
  vi.restoreAllMocks();
});

const sampleEvent: FriendEvent = {
  id: "event-1",
  userId: "user-a",
  sessionId: "session-1",
  type: "SESSION_STARTED",
  displayLabel: "started a focus session",
  occurredAt: new Date("2026-01-01T12:00:00Z").getTime(),
};

const sampleNudge: FriendNudge = {
  id: "nudge-1",
  senderUserId: "user-friend",
  recipientUserId: "user-self",
  messageId: "keep-going",
  sentAt: new Date("2026-01-01T12:05:00Z").getTime(),
};

// On mount, FriendGroupPanel now fires several independent sendMessage calls (v2 Task 7:
// FRIEND_EVENTS_FETCH, AUTH_GET_SESSION, GROUP_LIST_MINE -> GROUP_LIST_MEMBERS per group,
// NUDGES_FETCH) - a single blanket `mockResolvedValue` (this file's pre-Task-7 style) would
// route the same response to every one of them, which breaks the moment any of them need
// different shapes. This router lets each test override only the message types it cares about;
// everything else gets a healthy, empty-but-ok default so unrelated sections of the panel render
// their "nothing here" state instead of an error.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    FRIEND_EVENTS_FETCH: () => ({ ok: true, events: [] }),
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    GROUP_LIST_MINE: () => ({ ok: true, memberships: [] }),
    GROUP_LIST_MEMBERS: () => ({ ok: true, members: [] }),
    NUDGES_FETCH: () => ({ ok: true, nudges: [] }),
    NUDGE_SEND: () => ({ ok: true }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

function callsOfType(spy: { mock: { calls: unknown[][] } }, type: ExtensionMessage["type"]) {
  return spy.mock.calls.filter((call) => (call[0] as ExtensionMessage).type === type);
}

describe("FriendGroupPanel — friend activity (pre-existing behavior)", () => {
  it("fetches friend events on mount via FRIEND_EVENTS_FETCH and renders them", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(routeSendMessage({ FRIEND_EVENTS_FETCH: () => ({ ok: true, events: [sampleEvent] }) }));

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "FRIEND_EVENTS_FETCH",
        payload: { sinceTimestamp: expect.any(Number) },
      })
    );
    await waitFor(() => expect(screen.getByText("started a focus session")).toBeInTheDocument());
    expect(screen.getByText(/user-a/)).toBeInTheDocument();
  });

  it("shows a no-activity message when there are no events", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("No recent friend activity.")).toBeInTheDocument());
  });

  it("shows an error message when the fetch response is ok:false", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIEND_EVENTS_FETCH: () => ({ ok: false, error: "Not signed in." }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load friend activity/)).toHaveTextContent("Not signed in.")
    );
  });

  it("surfaces an error and does not crash when sendMessage rejects", async () => {
    // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
    // connection. Receiving end does not exist." during service-worker startup races, or
    // extension-context-invalidated.
    vi.spyOn(messenger, "sendMessage").mockImplementation((msg: ExtensionMessage) =>
      msg.type === "FRIEND_EVENTS_FETCH"
        ? Promise.reject(new Error("connection lost"))
        : routeSendMessage({})(msg)
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load friend activity/)).toHaveTextContent("connection lost")
    );
  });

  it("refetches friend events specifically when the Refresh button is clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(callsOfType(sendMessageSpy, "FRIEND_EVENTS_FETCH")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(callsOfType(sendMessageSpy, "FRIEND_EVENTS_FETCH")).toHaveLength(2));
  });

  it("calls onClose when Close is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));
    const onClose = vi.fn();

    render(<FriendGroupPanel onClose={onClose} />);
    await waitFor(() => screen.getByText("No recent friend activity."));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });
});

describe("FriendGroupPanel — send a nudge (v2 Task 7)", () => {
  it("discovers friends via GROUP_LIST_MINE + GROUP_LIST_MEMBERS (excluding self) and renders the predefined message catalog", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        GROUP_LIST_MINE: () => ({
          ok: true,
          memberships: [{ groupId: "group-1", userId: "user-self", joinedAt: "2026-01-01T00:00:00Z" }],
        }),
        GROUP_LIST_MEMBERS: () => ({
          ok: true,
          members: [
            { groupId: "group-1", userId: "user-self", joinedAt: "2026-01-01T00:00:00Z" },
            { groupId: "group-1", userId: "user-friend", joinedAt: "2026-01-01T00:00:00Z" },
          ],
        }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    // "user-self" (the current user) must never appear as a nudge target.
    await waitFor(() => expect(screen.getByRole("option", { name: "user-friend" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "user-self" })).not.toBeInTheDocument();

    // The predefined catalog (domain/accountability/nudgeMessages.ts) renders as buttons - not a
    // free-text input, since nudges are predefined-only.
    expect(screen.getByRole("button", { name: "You've got this." })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows a 'no friends yet' message when the user has no groups", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/No friends to nudge yet/)).toBeInTheDocument());
  });

  it("sends NUDGE_SEND with the selected friend and message, and shows a confirmation on success", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        GROUP_LIST_MINE: () => ({
          ok: true,
          memberships: [{ groupId: "group-1", userId: "user-self", joinedAt: "x" }],
        }),
        GROUP_LIST_MEMBERS: () => ({
          ok: true,
          members: [{ groupId: "group-1", userId: "user-friend", joinedAt: "x" }],
        }),
        NUDGE_SEND: () => ({ ok: true }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: "You've got this." }));

    fireEvent.click(screen.getByRole("button", { name: "You've got this." }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "NUDGE_SEND",
        payload: { friendUserId: "user-friend", messageId: "you-got-this" },
      })
    );
    await waitFor(() => expect(screen.getByText("Nudge sent.")).toBeInTheDocument());
  });

  it("shows the server's rejection reason inline (e.g. cooldown/toggle off) on ok:false, without silently swallowing it", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        GROUP_LIST_MINE: () => ({
          ok: true,
          memberships: [{ groupId: "group-1", userId: "user-self", joinedAt: "x" }],
        }),
        GROUP_LIST_MEMBERS: () => ({
          ok: true,
          members: [{ groupId: "group-1", userId: "user-friend", joinedAt: "x" }],
        }),
        NUDGE_SEND: () => ({
          ok: false,
          error: "Couldn't send that nudge — this friend may have nudges turned off, or you're on cooldown.",
        }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: "You've got this." }));

    fireEvent.click(screen.getByRole("button", { name: "You've got this." }));

    await waitFor(() =>
      expect(screen.getByText(/Couldn't send that nudge/)).toHaveTextContent("cooldown")
    );
  });
});

describe("FriendGroupPanel — incoming nudges (v2 Task 7)", () => {
  it("renders an incoming nudge using the SnufflesOverlay warning visual pattern (same CSS classes, role=alert, Snuffles image, message text, sender)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [sampleNudge] }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    // Scoped by the exact reused CSS class (rather than assuming there's only ever one
    // role="alert" on the page - error banners elsewhere in the panel use it too) to confirm
    // this specific card is what SnufflesOverlay.tsx's warning state renders: same classes,
    // role=alert, a Snuffles image, and the nudge's message text + sender.
    const card = await waitFor(() => {
      const el = document.querySelector(".snuffles-overlay.snuffles-overlay--warning");
      if (!el) throw new Error("incoming nudge card not rendered yet");
      return el as HTMLElement;
    });
    expect(card.getAttribute("role")).toBe("alert");
    expect(within(card).getByRole("img", { name: "Snuffles" })).toBeInTheDocument();
    expect(within(card).getByText("Thinking of you — keep going!")).toBeInTheDocument();
    expect(within(card).getByText(/user-friend/)).toBeInTheDocument();
  });

  it("dismisses the visible nudge and reveals the next queued one when Dismiss is clicked", async () => {
    const secondNudge: FriendNudge = {
      ...sampleNudge,
      id: "nudge-2",
      messageId: "you-got-this",
      sentAt: sampleNudge.sentAt + 1000,
    };
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [sampleNudge, secondNudge] }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Thinking of you — keep going!")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(screen.getByText("You've got this.")).toBeInTheDocument());
    expect(screen.queryByText("Thinking of you — keep going!")).not.toBeInTheDocument();
  });

  it("shows nothing extra when there are no incoming nudges", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => screen.getByText("No recent friend activity."));

    expect(document.querySelector(".snuffles-overlay")).not.toBeInTheDocument();
  });
});
