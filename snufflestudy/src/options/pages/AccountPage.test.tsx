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

    expect(await screen.findByText(/check a@example.com for an 8-digit code/i)).toBeInTheDocument();
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

  // v3.3 Task 5: "Invite a friend" collapses the old two-step create-group/generate-invite-code
  // flow into one action - one click sends both GROUP_CREATE (with an auto-generated, never-shown
  // name) and GROUP_GENERATE_INVITE_CODE, and only the resulting invite code renders.
  it("invites a friend: one click creates a group and generates an invite code for it", async () => {
    mockSignedIn({
      GROUP_CREATE: async () => ({
        ok: true,
        group: { id: "group-1", name: "Friends of a@example.com", ownerUserId: "user-a", createdAt: "2026-01-01T00:00:00Z" },
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
    await waitFor(() => screen.getByRole("button", { name: "Invite a friend" }));

    fireEvent.click(screen.getByRole("button", { name: "Invite a friend" }));

    expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "GROUP_CREATE",
      payload: { name: "Friends of a@example.com" },
    });
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "GROUP_GENERATE_INVITE_CODE",
      payload: { groupId: "group-1" },
    });
  });

  it("adds a friend by invite code", async () => {
    mockSignedIn({
      GROUP_JOIN: async () => ({
        ok: true,
        membership: { groupId: "group-1", userId: "user-a", joinedAt: "2026-01-02T00:00:00Z" },
      }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Invite code"));

    fireEvent.change(screen.getByLabelText("Invite code"), { target: { value: "code1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith({
        type: "GROUP_JOIN",
        payload: { code: "CODE1234" },
      })
    );
  });

  it("lists members for a given friend list id", async () => {
    mockSignedIn({
      GROUP_LIST_MEMBERS: async () => ({
        ok: true,
        members: [{ groupId: "group-1", userId: "user-a", joinedAt: "2026-01-01T00:00:00Z" }],
      }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Friend list ID"));

    fireEvent.change(screen.getByLabelText("Friend list ID"), { target: { value: "group-1" } });
    fireEvent.click(screen.getByRole("button", { name: "List members" }));

    expect(await screen.findByText(/user-a/i)).toBeInTheDocument();
  });

  // v2 follow-up (Item 2, post-final-review): self-leave UI, gated behind a confirmation step
  // (see AccountPage.tsx's handleLeaveGroup comment for why a bare click felt too easy to
  // mis-fire). QA-discovered bug (v3.2 Task 9): this used to be window.confirm(), which Chrome
  // silently no-ops with zero visible dialog when this Options page is shown embedded inside
  // chrome://extensions (this repo's default, per options_ui.open_in_tab: false) - replaced
  // with an inline two-click confirmation that works in every context this page can be viewed
  // in. These tests now click the button twice (arm, then confirm) instead of mocking
  // window.confirm.
  describe("leaving your friends list", () => {
    it("leaves the friend list typed into Friend list ID after confirming inline", async () => {
      const leaveSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({ GROUP_LEAVE: leaveSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByLabelText("Friend list ID"));
      fireEvent.change(screen.getByLabelText("Friend list ID"), { target: { value: "group-1" } });

      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
      fireEvent.click(await screen.findByRole("button", { name: /yes, leave/i }));

      await waitFor(() =>
        expect(leaveSpy).toHaveBeenCalledWith({
          type: "GROUP_LEAVE",
          payload: { groupId: "group-1" },
        })
      );
      expect(await screen.findByText(/you've left your friends list/i)).toBeInTheDocument();
    });

    it("does not send GROUP_LEAVE when the inline confirmation is cancelled", async () => {
      const leaveSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({ GROUP_LEAVE: leaveSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByLabelText("Friend list ID"));
      fireEvent.change(screen.getByLabelText("Friend list ID"), { target: { value: "group-1" } });

      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

      // Give any stray microtask a chance to run before asserting the negative.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(leaveSpy).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
    });

    it("surfaces a server-side denial (e.g. a non-owner trying to remove someone else) as an error", async () => {
      mockSignedIn({
        GROUP_LEAVE: async () => ({ ok: false, error: "Could not leave your friends list." }),
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByLabelText("Friend list ID"));
      fireEvent.change(screen.getByLabelText("Friend list ID"), { target: { value: "group-1" } });

      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
      fireEvent.click(await screen.findByRole("button", { name: /yes, leave/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/could not leave your friends list/i);
    });
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

  // v3.2 Task 8: account/data deletion, gated behind a confirmation step - same convention as
  // "leaving your friends list" above (see AccountPage.tsx's handleDeleteAccount comment).
  // QA-discovered bug (v3.2 Task 9): same window.confirm-in-an-embedded-options-page fix as
  // "leaving your friends list" above.
  describe("deleting the account", () => {
    it("deletes the account after confirming inline, and returns to the signed-out view", async () => {
      const deleteSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({ AUTH_DELETE_ACCOUNT: deleteSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
      fireEvent.click(await screen.findByRole("button", { name: /yes, permanently delete/i }));

      await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ type: "AUTH_DELETE_ACCOUNT" }));
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    });

    it("does not send AUTH_DELETE_ACCOUNT when the inline confirmation is cancelled", async () => {
      const deleteSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({ AUTH_DELETE_ACCOUNT: deleteSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

      // Give any stray microtask a chance to run before asserting the negative.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(screen.getByText(/signed in as a@example.com/i)).toBeInTheDocument();
    });

    it("surfaces a server-side/Edge Function failure as an error and stays signed in", async () => {
      mockSignedIn({
        AUTH_DELETE_ACCOUNT: async () => ({ ok: false, error: "Failed to delete your account." }),
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
      fireEvent.click(await screen.findByRole("button", { name: /yes, permanently delete/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /couldn.t delete your account: failed to delete your account/i
      );
      expect(screen.getByText(/signed in as a@example.com/i)).toBeInTheDocument();
    });
  });
});
