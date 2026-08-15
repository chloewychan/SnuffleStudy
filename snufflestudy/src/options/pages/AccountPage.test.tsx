import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AccountPage } from "./AccountPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AccountPage — signed out", () => {
  it("shows the email step, then the code step after requesting an OTP", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      return { ok: true };
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Email"));

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));

    expect(await screen.findByText(/check a@example.com for a 6-digit code/i)).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "AUTH_REQUEST_OTP",
      payload: { email: "a@example.com" },
    });
  });

  it("verifies the code and shows the signed-in state", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
      }
      return { ok: true };
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Email"));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    await screen.findByLabelText("Code");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByText(/signed in as a@example.com/i)).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "AUTH_VERIFY_OTP",
      payload: { email: "a@example.com", token: "123456" },
    });
  });

  it("surfaces an error when the code is wrong or expired", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: false, error: "Token has expired or is invalid" };
      }
      return { ok: true };
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Email"));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    await screen.findByLabelText("Code");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/token has expired or is invalid/i);
  });

  it("surfaces an error instead of hanging when the initial session fetch rejects", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );

    render(<AccountPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("AccountPage — signed in", () => {
  function mockSignedIn(overrides: Record<string, (message: any) => Promise<any>> = {}) {
    return vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      const override = overrides[message.type];
      if (override) return override(message);
      if (message.type === "AUTH_GET_SESSION") {
        return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
      }
      return { ok: true };
    });
  }

  it("creates a group and then generates an invite code for it", async () => {
    mockSignedIn({
      GROUP_CREATE: async () => ({
        ok: true,
        group: { id: "group-1", name: "Study Buddies", ownerUserId: "user-a", createdAt: "2026-01-01T00:00:00Z" },
      }),
      GROUP_GENERATE_INVITE_CODE: async () => ({
        ok: true,
        inviteCode: {
          code: "ABCD1234",
          groupId: "group-1",
          createdBy: "user-a",
          expiresAt: "2026-01-08T00:00:00Z",
          usedBy: null,
        },
      }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Group name"));

    fireEvent.change(screen.getByLabelText("Group name"), { target: { value: "Study Buddies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));

    expect(await screen.findByText(/created "study buddies"/i)).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "GROUP_CREATE",
      payload: { name: "Study Buddies" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate invite code" }));

    expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "GROUP_GENERATE_INVITE_CODE",
      payload: { groupId: "group-1" },
    });
  });

  it("joins a group by invite code", async () => {
    mockSignedIn({
      GROUP_JOIN: async () => ({
        ok: true,
        membership: { groupId: "group-1", userId: "user-a", joinedAt: "2026-01-02T00:00:00Z" },
      }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Invite code"));

    fireEvent.change(screen.getByLabelText("Invite code"), { target: { value: "code1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Join group" }));

    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith({
        type: "GROUP_JOIN",
        payload: { code: "CODE1234" },
      })
    );
  });

  it("lists members for a given group id", async () => {
    mockSignedIn({
      GROUP_LIST_MEMBERS: async () => ({
        ok: true,
        members: [{ groupId: "group-1", userId: "user-a", joinedAt: "2026-01-01T00:00:00Z" }],
      }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Group ID"));

    fireEvent.change(screen.getByLabelText("Group ID"), { target: { value: "group-1" } });
    fireEvent.click(screen.getByRole("button", { name: "List members" }));

    expect(await screen.findByText(/user-a/i)).toBeInTheDocument();
  });

  it("signs out and returns to the signed-out view", async () => {
    mockSignedIn({
      AUTH_SIGN_OUT: async () => ({ ok: true }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByText(/signed in as a@example.com/i));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });
});
