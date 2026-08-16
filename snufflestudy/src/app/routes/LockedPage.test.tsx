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
        codeHash: "",
        codeSalt: "",
        expiresAt: 0,
        failedAttempts: 0,
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

  it("shows a code-entry field once the request is approved, and navigates to the site on a correct code", async () => {
    delete (window as any).location;
    (window as any).location = { href: "" };

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
          codeHash: "",
          codeSalt: "",
          expiresAt: 0,
          failedAttempts: 0,
        },
      }),
      TEMP_PASSCODE_REDEEM: () => ({ ok: true }),
    });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() => expect(screen.getByPlaceholderText("Code from your friend")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Code from your friend"), {
      target: { value: "483920" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock with code" }));

    await waitFor(() => expect(window.location.href).toBe("https://youtube.com"));
  });

  it("shows an error on an incorrect temp passcode redemption, without navigating away", async () => {
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
          codeHash: "",
          codeSalt: "",
          expiresAt: 0,
          failedAttempts: 0,
        },
      }),
      TEMP_PASSCODE_REDEEM: () => ({ ok: false }),
    });
    render(<LockedPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request a temporary passcode" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a temporary passcode" }));

    await waitFor(() => expect(screen.getByPlaceholderText("Code from your friend")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Code from your friend"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock with code" }));

    await waitFor(() =>
      expect(
        screen.getByText("Incorrect code, or temporarily locked after repeated attempts.")
      ).toBeInTheDocument()
    );
  });
});
