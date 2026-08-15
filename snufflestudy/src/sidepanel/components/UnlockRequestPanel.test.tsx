import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UnlockRequestPanel } from "./UnlockRequestPanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { UnlockRequest } from "../../infrastructure/backend/unlockRequestApi";
import type { ExtensionMessage } from "../../shared/messages";
import type { StudySession } from "../../domain/session/sessionTypes";

beforeEach(() => {
  vi.restoreAllMocks();
});

const activeSession: StudySession = {
  id: "session-1",
  goal: "Finish reading",
  state: "FOCUSING",
  interventionLevel: "none",
  activityState: "active",
  createdAt: Date.now(),
  startedAt: Date.now(),
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
  accountabilityUserIds: [],
  distractionAttempts: 0,
  recoveries: 0,
  friendNudges: 0,
};

const pendingFromFriend: UnlockRequest = {
  id: "req-friend-1",
  sessionId: "session-friend-1",
  requesterUserId: "user-friend",
  hostname: "instagram.com",
  status: "pending",
  requestedAt: Date.now(),
  resolvedAt: null,
  resolvedBy: null,
};

const myOwnPendingRequest: UnlockRequest = {
  id: "req-mine-1",
  sessionId: "session-1",
  requesterUserId: "user-self",
  hostname: "reddit.com",
  status: "pending",
  requestedAt: Date.now(),
  resolvedAt: null,
  resolvedBy: null,
};

// Mirrors FriendGroupPanel.test.tsx's routeSendMessage helper exactly - lets each test override
// only the message types it cares about, everything else gets a healthy, empty-but-ok default.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    UNLOCK_REQUESTS_FETCH: () => ({ ok: true, requests: [] }),
    SESSION_LIST_EVENTS: () => ({ ok: true, events: [] }),
    UNLOCK_REQUEST_CREATE: () => ({ ok: true, request: myOwnPendingRequest }),
    UNLOCK_REQUEST_RESOLVE: () => ({ ok: true }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

describe("UnlockRequestPanel — requester side", () => {
  it("shows the 'request an unlock' section when a non-terminal session is active", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<UnlockRequestPanel session={activeSession} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("Request an unlock")).toBeInTheDocument());
  });

  it("hides the 'request an unlock' section when there is no active session", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<UnlockRequestPanel session={null} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("Requests from friends")).toBeInTheDocument());
    expect(screen.queryByText("Request an unlock")).not.toBeInTheDocument();
  });

  it("sends UNLOCK_REQUEST_CREATE with the typed hostname and the active session's id", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        UNLOCK_REQUEST_CREATE: () => ({
          ok: true,
          request: { ...myOwnPendingRequest, hostname: "twitter.com" },
        }),
      })
    );

    render(<UnlockRequestPanel session={activeSession} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Request an unlock")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("e.g. youtube.com"), {
      target: { value: "twitter.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request unlock" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "UNLOCK_REQUEST_CREATE",
        payload: { sessionId: "session-1", hostname: "twitter.com" },
      })
    );
    await waitFor(() => expect(screen.getByText(/twitter\.com — Pending/)).toBeInTheDocument());
  });

  it("prefills the hostname field from a blocked-site quick-fill suggestion (derived from SESSION_LIST_EVENTS)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        SESSION_LIST_EVENTS: () => ({
          ok: true,
          events: [
            {
              id: "evt-1",
              sessionId: "session-1",
              type: "DISTRACTION_ATTEMPT",
              occurredAt: Date.now(),
              hostname: "youtube.com",
            },
          ],
        }),
      })
    );

    render(<UnlockRequestPanel session={activeSession} onClose={() => {}} />);

    const suggestionButton = await screen.findByRole("button", { name: "youtube.com" });
    fireEvent.click(suggestionButton);

    expect(screen.getByPlaceholderText("e.g. youtube.com")).toHaveValue("youtube.com");
  });

  it("surfaces a server-side rejection from UNLOCK_REQUEST_CREATE inline", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        UNLOCK_REQUEST_CREATE: () => ({ ok: false, error: "Not signed in." }),
      })
    );

    render(<UnlockRequestPanel session={activeSession} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Request an unlock")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("e.g. youtube.com"), {
      target: { value: "twitter.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request unlock" }));

    await waitFor(() =>
      expect(screen.getByText(/Request not sent: Not signed in\./)).toBeInTheDocument()
    );
  });

  it("shows the current status of the requester's own requests for this session", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        UNLOCK_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [{ ...myOwnPendingRequest, status: "approved" }],
        }),
      })
    );

    render(<UnlockRequestPanel session={activeSession} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/reddit\.com — Approved/)).toBeInTheDocument());
  });
});

describe("UnlockRequestPanel — friend side", () => {
  it("lists pending requests from others (not the current user's own) with approve/deny buttons", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        UNLOCK_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [pendingFromFriend, myOwnPendingRequest],
        }),
      })
    );

    render(<UnlockRequestPanel session={activeSession} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/user-friend wants to unlock instagram\.com/)).toBeInTheDocument()
    );
    // The current user's own pending request must not appear in the friend-approval list.
    expect(screen.queryByText(/wants to unlock reddit\.com/)).not.toBeInTheDocument();
  });

  it("shows a no-pending-requests message when there is nothing to review", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<UnlockRequestPanel session={null} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("No pending unlock requests from friends.")).toBeInTheDocument()
    );
  });

  it("Approve sends UNLOCK_REQUEST_RESOLVE with decision: approved for the given request", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        UNLOCK_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingFromFriend] }),
      })
    );

    render(<UnlockRequestPanel session={null} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/wants to unlock instagram\.com/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "UNLOCK_REQUEST_RESOLVE",
        payload: { requestId: "req-friend-1", decision: "approved" },
      })
    );
  });

  it("Deny sends UNLOCK_REQUEST_RESOLVE with decision: denied, and the request disappears from the pending list on success", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        UNLOCK_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingFromFriend] }),
      })
    );

    render(<UnlockRequestPanel session={null} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/wants to unlock instagram\.com/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "UNLOCK_REQUEST_RESOLVE",
        payload: { requestId: "req-friend-1", decision: "denied" },
      })
    );
    await waitFor(() =>
      expect(screen.queryByText(/wants to unlock instagram\.com/)).not.toBeInTheDocument()
    );
  });

  it("surfaces a first-responder-wins rejection inline and refreshes the list", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        UNLOCK_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingFromFriend] }),
        UNLOCK_REQUEST_RESOLVE: () => ({
          ok: false,
          error: "Could not resolve this request — it may already have been resolved.",
        }),
      })
    );

    render(<UnlockRequestPanel session={null} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/wants to unlock instagram\.com/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByText(/already have been resolved/)).toBeInTheDocument()
    );
    // Confirms the panel re-fetches to reconcile state after a rejected resolve, rather than
    // trusting its own optimistic assumption.
    expect(
      sendMessageSpy.mock.calls.filter((call) => (call[0] as ExtensionMessage).type === "UNLOCK_REQUESTS_FETCH")
        .length
    ).toBeGreaterThan(1);
  });
});
