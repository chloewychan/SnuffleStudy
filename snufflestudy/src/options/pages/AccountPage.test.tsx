import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AccountPage } from "./AccountPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

// v3.3 Task 14: SignInForm now splits into a top-level Create account/Sign in choice (Decision
// 6). These "signed out" tests exercise the Sign in branch's "Email me a code" option - the
// unchanged OTP round trip that still calls onSignedIn directly with no completion step (the
// account already exists) - since that's the closest analog to what these tests covered before
// the split. SignInForm.test.tsx has full coverage of both branches (including v3.4 Task 7's
// single-screen create-account flow and its automatic completion-on-verify) at the component
// level; the account-creation branch is covered end to end from this page's own call site in the
// "creating a new account" describe block below.
function goToSignInWithCode() {
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
}

describe("AccountPage — signed out", () => {
  it("shows the email step, then the code step after requesting an OTP", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      return { ok: true };
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByRole("button", { name: "Sign in" }));
    goToSignInWithCode();

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
    await waitFor(() => screen.getByRole("button", { name: "Sign in" }));
    goToSignInWithCode();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    await screen.findByLabelText("Code");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByText(/signed in as a@example.com/i)).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "AUTH_VERIFY_OTP",
      payload: { email: "a@example.com", token: "12345678" },
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
    await waitFor(() => screen.getByRole("button", { name: "Sign in" }));
    goToSignInWithCode();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    await screen.findByLabelText("Code");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "00000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/token has expired or is invalid/i);
  });

  // v3.4 Task 7: account creation is now one "create-details" screen (name/bunny name/email/
  // password x2) ahead of the OTP step, with completion (AUTH_SET_PASSWORD then
  // PROFILE_SAVE_MINE) firing automatically the instant the code verifies - exercised end to end
  // from this page's own call site (SignInForm.test.tsx covers the component's internal
  // mechanics, e.g. the disabled-submit assertion and the Retry-without-re-verifying path, in
  // more detail).
  describe("creating a new account", () => {
    it("does not sign in if account completion (AUTH_SET_PASSWORD) fails after a verified code", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        if (message.type === "AUTH_VERIFY_OTP") {
          return { ok: true, session: { user: { id: "user-new", email: "new@example.com" } } };
        }
        if (message.type === "AUTH_SET_PASSWORD") {
          return { ok: false, error: "Password should be at least 6 characters" };
        }
        return { ok: true };
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByRole("button", { name: "Create account" }));
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Robin" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "correct-horse" },
      });
      fireEvent.change(screen.getByLabelText("Confirm password"), {
        target: { value: "correct-horse" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
      await screen.findByLabelText("Code");

      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /password should be at least 6 characters/i
      );
      expect(screen.queryByText(/signed in as/i)).not.toBeInTheDocument();
    });

    it("signs in once the code is verified AND account completion (AUTH_SET_PASSWORD + PROFILE_SAVE_MINE) both succeed", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        if (message.type === "AUTH_VERIFY_OTP") {
          return { ok: true, session: { user: { id: "user-new", email: "new@example.com" } } };
        }
        if (message.type === "AUTH_SET_PASSWORD") return { ok: true };
        if (message.type === "PROFILE_SAVE_MINE") return { ok: true };
        return { ok: true };
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByRole("button", { name: "Create account" }));
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Robin" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "correct-horse" },
      });
      fireEvent.change(screen.getByLabelText("Confirm password"), {
        target: { value: "correct-horse" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
      await screen.findByLabelText("Code");

      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

      expect(await screen.findByText(/signed in as new@example.com/i)).toBeInTheDocument();
    });
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
  // v4.1 Task 9: "Invite a friend"/"Add a friend"/"Your friends" (and the FRIENDS_LIST fetch that
  // backed the last of those) have moved out of this page entirely, into the sidepanel's new
  // FriendsBox.tsx (scope doc's Friends Tab section) - this page no longer sends FRIENDS_LIST at
  // all, so the override map below only ever needs AUTH_GET_SESSION's default.
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

  // v3.3 Task 14: "set/change your password" for an already-signed-in user - the recovery path
  // for a pre-existing no-password account (created before this feature shipped), and the normal
  // way to change a password later.
  describe("password", () => {
    it("disables Save Password until both fields are filled and match (genuinely disabled, not just visual)", async () => {
      mockSignedIn();
      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      const submitButton = screen.getByRole("button", { name: "Save Password" });
      expect(submitButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "new-pw" } });
      expect(submitButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Confirm New Password"), {
        target: { value: "does-not-match" },
      });
      expect(submitButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Confirm New Password"), {
        target: { value: "new-pw" },
      });
      expect(submitButton).not.toBeDisabled();
    });

    it("sets a password via AUTH_SET_PASSWORD and shows confirmation", async () => {
      const setPasswordSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({ AUTH_SET_PASSWORD: setPasswordSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "new-pw" } });
      fireEvent.change(screen.getByLabelText("Confirm New Password"), {
        target: { value: "new-pw" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save Password" }));

      await waitFor(() =>
        expect(setPasswordSpy).toHaveBeenCalledWith({
          type: "AUTH_SET_PASSWORD",
          payload: { password: "new-pw" },
        })
      );
      expect(await screen.findByText("Password updated.")).toBeInTheDocument();
    });

    it("surfaces a server-side failure as an error", async () => {
      mockSignedIn({
        AUTH_SET_PASSWORD: async () => ({
          ok: false,
          error: "Password should be at least 6 characters",
        }),
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "x" } });
      fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", { name: "Save Password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /password should be at least 6 characters/i
      );
      expect(screen.queryByText("Password updated.")).not.toBeInTheDocument();
    });

    // v3.4 Task 6: `passwordSetAt` (loaded via PROFILE_GET_MINE) gates whether a "Current
    // password" field renders/is required at all - these two states are asserted explicitly here
    // rather than only via the JSX, per this task's own DoD.
    it("does not render an Old Password field for an account that has never had a password", async () => {
      mockSignedIn();
      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      expect(screen.queryByLabelText("Old Password")).not.toBeInTheDocument();
    });

    function mockSignedInWithExistingPassword(
      overrides: Record<string, (message: any) => Promise<any>> = {}
    ) {
      return mockSignedIn({
        PROFILE_GET_MINE: async () => ({
          ok: true,
          profile: {
            userId: "user-a",
            humanName: null,
            bunnyName: null,
            updatedAt: "2026-01-01T00:00:00Z",
            passwordSetAt: 1700000000000,
          },
        }),
        ...overrides,
      });
    }

    it("renders and requires an Old Password field for an account that already has a password", async () => {
      mockSignedInWithExistingPassword();
      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      expect(await screen.findByLabelText("Old Password")).toBeInTheDocument();

      const submitButton = screen.getByRole("button", { name: "Save Password" });
      fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "new-pw" } });
      fireEvent.change(screen.getByLabelText("Confirm New Password"), {
        target: { value: "new-pw" },
      });
      // New/confirm match, but Old Password is still empty - stays disabled.
      expect(submitButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Old Password"), { target: { value: "old-pw" } });
      expect(submitButton).not.toBeDisabled();
    });

    it("sends currentPassword in the AUTH_SET_PASSWORD payload for an account that already has a password", async () => {
      const setPasswordSpy = vi.fn(async () => ({ ok: true }));
      mockSignedInWithExistingPassword({ AUTH_SET_PASSWORD: setPasswordSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));
      await screen.findByLabelText("Old Password");

      fireEvent.change(screen.getByLabelText("Old Password"), { target: { value: "old-pw" } });
      fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "new-pw" } });
      fireEvent.change(screen.getByLabelText("Confirm New Password"), {
        target: { value: "new-pw" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save Password" }));

      await waitFor(() =>
        expect(setPasswordSpy).toHaveBeenCalledWith({
          type: "AUTH_SET_PASSWORD",
          payload: { password: "new-pw", currentPassword: "old-pw" },
        })
      );
      // Success clears currentPassword alongside the other two fields.
      await waitFor(() => expect(screen.getByLabelText("Old Password")).toHaveValue(""));
    });

    it("surfaces 'Current password is incorrect' without clearing the Old Password field", async () => {
      mockSignedInWithExistingPassword({
        AUTH_SET_PASSWORD: async () => ({ ok: false, error: "Current password is incorrect." }),
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));
      await screen.findByLabelText("Old Password");

      fireEvent.change(screen.getByLabelText("Old Password"), { target: { value: "wrong-pw" } });
      fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "new-pw" } });
      fireEvent.change(screen.getByLabelText("Confirm New Password"), {
        target: { value: "new-pw" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save Password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/current password is incorrect/i);
      // "Don't wipe input on a failed attempt" - the field the user needs to look at again.
      expect(screen.getByLabelText("Old Password")).toHaveValue("wrong-pw");
    });
  });

  // v3.3 Task 14 DoD: "An account created before this feature shipped (no password set) can
  // still sign in via 'Email me a code,' and can set a password afterward from AccountPage.tsx."
  it("a pre-existing no-password account signs in via code, then sets a password afterward", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: true, session: { user: { id: "user-legacy", email: "legacy@example.com" } } };
      }
      if (message.type === "AUTH_SET_PASSWORD") return { ok: true };
      return { ok: true };
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "legacy@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    await screen.findByLabelText("Code");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    // Signed in via code alone - no password step tacked on for the sign-in branch.
    expect(await screen.findByText(/signed in as legacy@example.com/i)).toBeInTheDocument();

    // The recovery path: set a password now, from AccountPage's own "Account Password" section.
    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "fresh-pw" } });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), {
      target: { value: "fresh-pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Password" }));

    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "AUTH_SET_PASSWORD",
      payload: { password: "fresh-pw" },
    });
  });

  it("signs out and returns to the signed-out view", async () => {
    mockSignedIn({
      AUTH_SIGN_OUT: async () => ({ ok: true }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByText(/signed in as a@example.com/i));

    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));

    // v3.3 Task 14: the signed-out view is now SignInForm's entry choice, not a bare email
    // field - see SignInForm.test.tsx for full coverage of the Create account/Sign in split.
    expect(await screen.findByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
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

      fireEvent.click(screen.getByRole("button", { name: "Delete Account" }));
      fireEvent.click(await screen.findByRole("button", { name: /yes, permanently delete/i }));

      await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ type: "AUTH_DELETE_ACCOUNT" }));
      // v3.3 Task 14: the signed-out view is now SignInForm's entry choice, not a bare email
      // field.
      expect(await screen.findByRole("button", { name: "Create account" })).toBeInTheDocument();
    });

    it("does not send AUTH_DELETE_ACCOUNT when the inline confirmation is cancelled", async () => {
      const deleteSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({ AUTH_DELETE_ACCOUNT: deleteSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      fireEvent.click(screen.getByRole("button", { name: "Delete Account" }));
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

      fireEvent.click(screen.getByRole("button", { name: "Delete Account" }));
      fireEvent.click(await screen.findByRole("button", { name: /yes, permanently delete/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /couldn.t delete your account: failed to delete your account/i
      );
      expect(screen.getByText(/signed in as a@example.com/i)).toBeInTheDocument();
    });
  });
});
