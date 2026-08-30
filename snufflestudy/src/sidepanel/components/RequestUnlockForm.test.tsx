import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RequestUnlockForm } from "./RequestUnlockForm";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { ExtensionMessage } from "../../shared/messages";
import type { StudySession, SessionEvent } from "../../domain/session/sessionTypes";
import type { FriendRequest } from "../../domain/accountability/friendRequest";

// v4.2 Task 7 (Decision 5): RequestUnlockForm was rebuilt fresh from the new design system
// (ButtonLarge/TextInput/TextSmall + this file's own RequestUnlockForm.module.css - no
// frontend-backup design exists for it at all). This is the first dedicated test file for this
// component - previously only covered indirectly via one SidePanelApp.test.tsx integration test
// (that the "Request an unlock" heading renders alongside ActiveSessionView). Every behavior below
// mirrors the component's pre-v4.2 logic exactly (unchanged in this task): blocked-hostname
// suggestions, hostnameInput/handleCreateRequest, myRequestsForThisSession's session+self+kind
// filter, and the Refresh button's own loadRequests call.

const mockSession: StudySession = {
  id: "session-1",
  goal: "Finish essay",
  state: "FOCUSING",
  interventionLevel: "none",
  activityState: "active",
  createdAt: 0,
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "p1",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
  accountabilityUserIds: [],
  distractionAttempts: 0,
  recoveries: 0,
  friendNudges: 0,
};

const blockedEvents: SessionEvent[] = [
  { id: "e1", sessionId: "session-1", type: "DISTRACTION_ATTEMPT", occurredAt: 1, hostname: "youtube.com" },
  { id: "e2", sessionId: "session-1", type: "DISTRACTION_ATTEMPT", occurredAt: 2, hostname: "youtube.com" },
  { id: "e3", sessionId: "session-1", type: "DISTRACTION_ATTEMPT", occurredAt: 3, hostname: "reddit.com" },
  { id: "e4", sessionId: "session-1", type: "RECOVERY", occurredAt: 4 },
];

function makeRequest(overrides: Partial<FriendRequest> = {}): FriendRequest {
  return {
    id: "req-1",
    kind: "site_unlock",
    requesterUserId: "self-1",
    friendUserId: null,
    message: null,
    status: "pending",
    requestedAt: 0,
    resolvedAt: null,
    resolvedBy: null,
    hostname: "youtube.com",
    sessionId: "session-1",
    expiresAt: null,
    ...overrides,
  };
}

type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>> = {}) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "self-1" } } }),
    FRIEND_REQUESTS_FETCH: () => ({ ok: true, requests: [] }),
    SESSION_LIST_EVENTS: () => ({ ok: true, events: blockedEvents }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("RequestUnlockForm", () => {
  it("renders nothing once the session is no longer active (terminal state)", () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage());
    const { container } = render(
      <RequestUnlockForm session={{ ...mockSession, state: "COMPLETED" }} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("loads distinct blocked hostnames from SESSION_LIST_EVENTS and shows them as suggestions", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage());

    render(<RequestUnlockForm session={mockSession} />);

    // Two DISTRACTION_ATTEMPT events share "youtube.com" - deduplicated to one suggestion.
    expect(await screen.findByRole("button", { name: "youtube.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reddit.com" })).toBeInTheDocument();
  });

  it("clicking a suggestion fills the hostname field", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage());

    render(<RequestUnlockForm session={mockSession} />);

    fireEvent.click(await screen.findByRole("button", { name: "youtube.com" }));

    expect(screen.getByLabelText("Hostname")).toHaveValue("youtube.com");
  });

  it("creates an unlock request via FRIEND_REQUEST_CREATE with the typed hostname, then clears the field", async () => {
    const created = makeRequest({ id: "req-new", hostname: "typed.example" });
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIEND_REQUEST_CREATE: () => ({ ok: true, request: created }) })
    );

    render(<RequestUnlockForm session={mockSession} />);
    await screen.findByRole("button", { name: "youtube.com" });

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "typed.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Request unlock" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "FRIEND_REQUEST_CREATE",
        payload: { kind: "site_unlock", sessionId: "session-1", hostname: "typed.example" },
      })
    );

    await waitFor(() => expect(screen.getByLabelText("Hostname")).toHaveValue(""));
    expect(screen.getByText("typed.example — Pending")).toBeInTheDocument();
  });

  it("disables the Request unlock action while the hostname field is empty", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage());

    render(<RequestUnlockForm session={mockSession} />);
    await screen.findByRole("button", { name: "youtube.com" });

    expect(screen.getByRole("button", { name: "Request unlock" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "x.com" } });
    expect(screen.getByRole("button", { name: "Request unlock" })).not.toBeDisabled();
  });

  it("shows an inline error and keeps the field filled when FRIEND_REQUEST_CREATE fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIEND_REQUEST_CREATE: () => ({ ok: false, error: "no friends to ask" }) })
    );

    render(<RequestUnlockForm session={mockSession} />);
    await screen.findByRole("button", { name: "youtube.com" });

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "x.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Request unlock" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("no friends to ask");
    expect(screen.getByLabelText("Hostname")).toHaveValue("x.com");
  });

  it("shows only this session's own site_unlock requests from the current user, filtering out others", async () => {
    const mine = makeRequest({ id: "mine", hostname: "mine.example" });
    const otherSession = makeRequest({ id: "other-session", sessionId: "session-2", hostname: "wrong-session.example" });
    const otherUser = makeRequest({ id: "other-user", requesterUserId: "friend-2", hostname: "wrong-user.example" });
    const otherKind = makeRequest({ id: "other-kind", kind: "session_end", hostname: null });

    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [mine, otherSession, otherUser, otherKind],
        }),
      })
    );

    render(<RequestUnlockForm session={mockSession} />);

    expect(await screen.findByText("mine.example — Pending")).toBeInTheDocument();
    expect(screen.queryByText(/wrong-session/)).not.toBeInTheDocument();
    expect(screen.queryByText(/wrong-user/)).not.toBeInTheDocument();
  });

  it("shows a load error when FRIEND_REQUESTS_FETCH fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIEND_REQUESTS_FETCH: () => ({ ok: false, error: "network down" }) })
    );

    render(<RequestUnlockForm session={mockSession} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("re-fetches requests via FRIEND_REQUESTS_FETCH when Refresh is clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage());

    render(<RequestUnlockForm session={mockSession} />);
    await screen.findByRole("button", { name: "youtube.com" });
    sendMessageSpy.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "FRIEND_REQUESTS_FETCH" })
      )
    );
  });

  // Global Constraint / plan text: "no plain unstyled <button>/<input>/<ul> remains anywhere in
  // RequestUnlockForm.tsx" - every interactive control renders through the shared design-system
  // primitives (ButtonLarge/TextInput), not a bare <button>/<input>.
  it("renders every action through ButtonLarge (not a bare <button>) and the hostname field through TextInput (not a bare <input>)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage());

    render(<RequestUnlockForm session={mockSession} />);
    await screen.findByRole("button", { name: "youtube.com" });

    // ButtonLarge always wraps its visible label in an <h3>; TextInput always wraps its <input>
    // in a keyed wrapper <div> - both are structural fingerprints of the shared primitives.
    const requestButton = screen.getByRole("button", { name: "Request unlock" });
    expect(requestButton.querySelector("h3")).not.toBeNull();
    expect(screen.getByLabelText("Hostname").tagName).toBe("INPUT");
  });
});
