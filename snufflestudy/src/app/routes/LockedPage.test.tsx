import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LockedPage } from "./LockedPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/locked.html?site=youtube.com");
});

// v2 Task 12: LockedPage.tsx now also fetches the active session (for sessionId) and the current
// user's friends (for the temp-passcode friend picker) on mount, so a blanket
// `mockResolvedValue({ok: ...})` (this file's pre-Task-12 convention) would make EVERY message -
// including AUTH_GET_SESSION - resolve the same way, which spuriously populates friendsError
// alongside the permanent-passcode error in some tests. A per-message-type dispatcher avoids
// that, while `defaults` gives every pre-existing test (which only cares about
// HARD_BLOCK_VERIFY_PASSCODE) a clean, error-free baseline for the new mount-time calls it never
// used to have to think about.
function mockMessages(overrides: Record<string, (payload: any) => unknown> = {}) {
  const defaults: Record<string, (payload: any) => unknown> = {
    SESSION_GET_ACTIVE: () => ({ ok: true, session: { id: "session-1" } }),
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-a" } } }),
    GROUP_LIST_MINE: () => ({ ok: true, memberships: [{ groupId: "group-1", userId: "user-a", joinedAt: "" }] }),
    GROUP_LIST_MEMBERS: () => ({
      ok: true,
      members: [
        { groupId: "group-1", userId: "user-a", joinedAt: "" },
        { groupId: "group-1", userId: "user-b", joinedAt: "" },
      ],
    }),
  };
  const handlers = { ...defaults, ...overrides };
  return vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
    const handler = handlers[message.type];
    return handler ? handler(message.payload) : { ok: true };
  });
}

describe("LockedPage", () => {
  it("shows the restricted hostname from the query string", () => {
    mockMessages();
    render(<LockedPage />);
    expect(screen.getByText(/youtube.com is hard-restricted/)).toBeInTheDocument();
  });

  it("shows an error on an incorrect passcode", async () => {
    mockMessages({ HARD_BLOCK_VERIFY_PASSCODE: () => ({ ok: false }) });
    render(<LockedPage />);

    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("navigates to the site on a correct passcode", async () => {
    mockMessages({ HARD_BLOCK_VERIFY_PASSCODE: () => ({ ok: true }) });
    delete (window as any).location;
    (window as any).location = { href: "" };

    render(<LockedPage />);
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(window.location.href).toBe("https://youtube.com"));
  });

  it("shows the friend picker (populated from the user's groups) once loaded", async () => {
    mockMessages();
    render(<LockedPage />);

    await waitFor(() => expect(screen.getByText("Ask")).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "user-b" })).toBeInTheDocument();
  });

  it("creates a temp passcode request and shows its pending status", async () => {
    const createSpy = vi.fn(() => ({
      ok: true,
      request: {
        id: "req-1",
        sessionId: "session-1",
        hostname: "youtube.com",
        friendUserId: "user-b",
        requesterUserId: "user-a",
        status: "pending",
        expiresAt: 0,
      },
    }));
    mockMessages({ TEMP_PASSCODE_CREATE: createSpy });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() =>
      expect(screen.getByText("Waiting for your friend to respond…")).toBeInTheDocument()
    );
    expect(createSpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      hostname: "youtube.com",
      friendUserId: "user-b",
    });
  });

  // v3.3 Task 11: the optional "why do you need this" input is sent through as `message` when
  // filled in, trimmed.
  it("includes a trimmed message in TEMP_PASSCODE_CREATE when the requester fills it in", async () => {
    const createSpy = vi.fn(() => ({
      ok: true,
      request: {
        id: "req-1",
        sessionId: "session-1",
        hostname: "youtube.com",
        friendUserId: "user-b",
        requesterUserId: "user-a",
        status: "pending",
        expiresAt: 0,
        message: "Need to check the syllabus",
      },
    }));
    mockMessages({ TEMP_PASSCODE_CREATE: createSpy });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.change(screen.getByPlaceholderText("Why do you need this? (optional)"), {
      target: { value: "  Need to check the syllabus  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() =>
      expect(screen.getByText("Waiting for your friend to respond…")).toBeInTheDocument()
    );
    expect(createSpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      hostname: "youtube.com",
      friendUserId: "user-b",
      message: "Need to check the syllabus",
    });
  });

  // v3.3 Task 11 DoD: the field is optional - leaving it blank must not send an empty/whitespace
  // `message` key at all.
  it("omits the message key entirely when the field is left blank", async () => {
    const createSpy = vi.fn(() => ({
      ok: true,
      request: {
        id: "req-1",
        sessionId: "session-1",
        hostname: "youtube.com",
        friendUserId: "user-b",
        requesterUserId: "user-a",
        status: "pending",
        expiresAt: 0,
        message: null,
      },
    }));
    mockMessages({ TEMP_PASSCODE_CREATE: createSpy });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() =>
      expect(screen.getByText("Waiting for your friend to respond…")).toBeInTheDocument()
    );
    // Exact-object match (no `message` key at all, not even `message: undefined`) - same
    // assertion style the "creates a temp passcode request" test above uses.
    expect(createSpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      hostname: "youtube.com",
      friendUserId: "user-b",
    });
  });

  // v3.3 Task 10: no code to enter anymore - once the request's status is "approved", LockedPage
  // auto-claims it (TEMP_PASSCODE_CLAIM_APPROVAL) and navigates on success, with no user action in
  // between.
  it("auto-claims an approved request and navigates to the site, with no code entry anywhere", async () => {
    delete (window as any).location;
    (window as any).location = { href: "" };
    const claimSpy = vi.fn(() => ({ ok: true }));

    mockMessages({
      TEMP_PASSCODE_CREATE: () => ({
        ok: true,
        request: {
          id: "req-1",
          sessionId: "session-1",
          hostname: "youtube.com",
          friendUserId: "user-b",
          requesterUserId: "user-a",
          status: "approved",
          expiresAt: 0,
        },
      }),
      TEMP_PASSCODE_CLAIM_APPROVAL: claimSpy,
    });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() => expect(window.location.href).toBe("https://youtube.com"));
    // mockMessages' dispatcher (above) calls each handler with message.payload, not the whole
    // message - so this asserts the payload TEMP_PASSCODE_CLAIM_APPROVAL received, not the type.
    expect(claimSpy).toHaveBeenCalledWith({ requestId: "req-1" });
    expect(screen.queryByPlaceholderText("Code from your friend")).not.toBeInTheDocument();
  });

  it("shows an inline error with a retry button when claiming an approved request fails, without navigating away", async () => {
    mockMessages({
      TEMP_PASSCODE_CREATE: () => ({
        ok: true,
        request: {
          id: "req-1",
          sessionId: "session-1",
          hostname: "youtube.com",
          friendUserId: "user-b",
          requesterUserId: "user-a",
          status: "approved",
          expiresAt: 0,
        },
      }),
      TEMP_PASSCODE_CLAIM_APPROVAL: () => ({ ok: false }),
    });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() =>
      expect(
        screen.getByText("This pass couldn't be claimed — it may have expired. Ask again.")
      ).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retrying a failed claim re-fires TEMP_PASSCODE_CLAIM_APPROVAL for the same request", async () => {
    delete (window as any).location;
    (window as any).location = { href: "" };
    let attempt = 0;
    const claimSpy = vi.fn(() => {
      attempt += 1;
      return { ok: attempt > 1 };
    });

    mockMessages({
      TEMP_PASSCODE_CREATE: () => ({
        ok: true,
        request: {
          id: "req-1",
          sessionId: "session-1",
          hostname: "youtube.com",
          friendUserId: "user-b",
          requesterUserId: "user-a",
          status: "approved",
          expiresAt: 0,
        },
      }),
      TEMP_PASSCODE_CLAIM_APPROVAL: claimSpy,
    });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(window.location.href).toBe("https://youtube.com"));
    expect(claimSpy).toHaveBeenCalledTimes(2);
  });
});
