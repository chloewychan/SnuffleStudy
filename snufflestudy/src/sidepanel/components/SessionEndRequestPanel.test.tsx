import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionEndRequestPanel } from "./SessionEndRequestPanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { ExtensionMessage } from "../../shared/messages";
import type { SessionEndRequest } from "../../domain/accountability/sessionEndRequest";

beforeEach(() => {
  vi.restoreAllMocks();
});

const pendingFromA: SessionEndRequest = {
  id: "end-req-1",
  sessionId: "session-1",
  requesterUserId: "user-a",
  status: "pending",
  requestedAt: 0,
  resolvedAt: null,
  resolvedBy: null,
};

// Mirrors TempPasscodePanel.test.tsx's/UnlockRequestPanel.test.tsx's routeSendMessage helper
// exactly.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    SESSION_END_REQUESTS_FETCH: () => ({ ok: true, requests: [] }),
    SESSION_END_REQUEST_RESOLVE: () => ({ ok: true }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

describe("SessionEndRequestPanel", () => {
  it("shows a pending request addressed from a friend, with Approve/Deny actions", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        SESSION_END_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingFromA] }),
      })
    );

    render(<SessionEndRequestPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("user-a wants to end their session early")).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("does not show the current user's own pending request", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        SESSION_END_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [{ ...pendingFromA, requesterUserId: "user-self" }],
        }),
      })
    );

    render(<SessionEndRequestPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("No pending session-end requests from friends.")).toBeInTheDocument()
    );
  });

  it("does not show a request that isn't pending", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        SESSION_END_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [{ ...pendingFromA, status: "approved" }],
        }),
      })
    );

    render(<SessionEndRequestPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("No pending session-end requests from friends.")).toBeInTheDocument()
    );
  });

  it("approving a request removes it from the pending list", async () => {
    const approveSpy = vi.fn(() => ({ ok: true }));
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        SESSION_END_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingFromA] }),
        SESSION_END_REQUEST_RESOLVE: approveSpy,
      })
    );

    render(<SessionEndRequestPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.queryByText("user-a wants to end their session early")).not.toBeInTheDocument()
    );
    expect(approveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SESSION_END_REQUEST_RESOLVE",
        payload: { requestId: "end-req-1", decision: "approved" },
      })
    );
  });

  it("denying a request removes it from the pending list", async () => {
    const denySpy = vi.fn(() => ({ ok: true }));
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        SESSION_END_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingFromA] }),
        SESSION_END_REQUEST_RESOLVE: denySpy,
      })
    );

    render(<SessionEndRequestPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(screen.queryByText("user-a wants to end their session early")).not.toBeInTheDocument()
    );
    expect(denySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SESSION_END_REQUEST_RESOLVE",
        payload: { requestId: "end-req-1", decision: "denied" },
      })
    );
  });

  it("shows a server-side rejection (e.g. already resolved - first responder wins) inline and refreshes the list", async () => {
    const fetchSpy = vi.fn(() => ({ ok: true, requests: [pendingFromA] }));
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        SESSION_END_REQUESTS_FETCH: fetchSpy,
        SESSION_END_REQUEST_RESOLVE: () => ({
          ok: false,
          error: "Could not resolve that request — a friend may have already answered it.",
        }),
      })
    );

    render(<SessionEndRequestPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText("Could not resolve that request — a friend may have already answered it.")
      ).toBeInTheDocument()
    );
    // loadRequests() is called again on a failed resolve, refreshing the (now-stale) list.
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("calls onClose when the Close button is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));
    const onClose = vi.fn();

    render(<SessionEndRequestPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });
});

// v3.2 Task 2 pattern, reused here: signed out, this panel would otherwise silently show "No
// pending session-end requests." (SESSION_END_REQUESTS_FETCH degrades to [] when signed out, per
// messageRouter.ts) - indistinguishable from actually having zero pending requests. This shows an
// inline sign-in prompt instead, same as TempPasscodePanel.tsx/UnlockRequestPanel.tsx.
describe("SessionEndRequestPanel — signed-out gate", () => {
  it("shows an inline sign-in prompt in the friends section when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    render(<SessionEndRequestPanel onClose={() => {}} />);

    expect(
      await screen.findByText("Sign in to see or resolve session-end requests from friends.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText("No pending session-end requests from friends.")).not.toBeInTheDocument();
  });
});
