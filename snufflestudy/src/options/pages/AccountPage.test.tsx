import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AccountPage } from "./AccountPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

// v3.3 Task 14: SignInForm now splits into a top-level Create account/Sign in choice (Decision
// 6). These "signed out" tests exercise the Sign in branch's "Email me a code" option - the
// unchanged OTP round trip that still calls onSignedIn directly with no password step (the
// account already exists) - since that's the closest analog to what these tests covered before
// the split. SignInForm.test.tsx has full coverage of both branches (including the mandatory
// create-account password step) at the component level; the account-creation branch is covered
// end to end from this page's own call site in the "creating a new account" describe block below.
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

  // v3.3 Task 14: creating a brand-new account requires both a verified code AND matching
  // passwords - exercised end to end from this page's own call site (SignInForm.test.tsx covers
  // the component's internal mechanics, e.g. the disabled-submit assertion, in more detail).
  describe("creating a new account", () => {
    it("does not sign in after a bare verified code - a password must be set first", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        if (message.type === "AUTH_VERIFY_OTP") {
          return { ok: true, session: { user: { id: "user-new", email: "new@example.com" } } };
        }
        return { ok: true };
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByRole("button", { name: "Create account" }));
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
      await screen.findByLabelText("Code");

      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

      await screen.findByLabelText("Password");
      expect(screen.queryByText(/signed in as/i)).not.toBeInTheDocument();
    });

    it("signs in once a verified code AND a matching password both succeed", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        if (message.type === "AUTH_VERIFY_OTP") {
          return { ok: true, session: { user: { id: "user-new", email: "new@example.com" } } };
        }
        if (message.type === "AUTH_SET_PASSWORD") return { ok: true };
        return { ok: true };
      });

      render(<AccountPage />);
      await waitFor(() => screen.getByRole("button", { name: "Create account" }));
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
      await screen.findByLabelText("Code");

      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

      await screen.findByLabelText("Password");
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse" } });
      fireEvent.change(screen.getByLabelText("Confirm password"), {
        target: { value: "correct-horse" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set password" }));

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
  // v3.4 Task 2: AccountPage now loads the flat "Your friends" list via one FRIENDS_LIST call as
  // soon as `session` is set - defaults to an empty list so every pre-existing test (which
  // doesn't care about the friends list) gets a clean, error-free baseline.
  function mockSignedIn(overrides: Record<string, (message: any) => Promise<any>> = {}) {
    return vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      const override = overrides[message.type];
      if (override) return override(message);
      if (message.type === "AUTH_GET_SESSION") {
        return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
      }
      if (message.type === "FRIENDS_LIST") {
        return { ok: true, friendIds: [] };
      }
      return { ok: true };
    });
  }

  // v3.3 Task 14: "set/change your password" for an already-signed-in user - the recovery path
  // for a pre-existing no-password account (created before this feature shipped), and the normal
  // way to change a password later.
  describe("password", () => {
    it("disables Set password until both fields are filled and match (genuinely disabled, not just visual)", async () => {
      mockSignedIn();
      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      const submitButton = screen.getByRole("button", { name: "Set password" });
      expect(submitButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-pw" } });
      expect(submitButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Confirm new password"), {
        target: { value: "does-not-match" },
      });
      expect(submitButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Confirm new password"), {
        target: { value: "new-pw" },
      });
      expect(submitButton).not.toBeDisabled();
    });

    it("sets a password via AUTH_SET_PASSWORD and shows confirmation", async () => {
      const setPasswordSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({ AUTH_SET_PASSWORD: setPasswordSpy });

      render(<AccountPage />);
      await waitFor(() => screen.getByText(/signed in as a@example.com/i));

      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-pw" } });
      fireEvent.change(screen.getByLabelText("Confirm new password"), {
        target: { value: "new-pw" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set password" }));

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

      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "x" } });
      fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", { name: "Set password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /password should be at least 6 characters/i
      );
      expect(screen.queryByText("Password updated.")).not.toBeInTheDocument();
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

    // The recovery path: set a password now, from AccountPage's own "Password" section.
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "fresh-pw" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "fresh-pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "AUTH_SET_PASSWORD",
      payload: { password: "fresh-pw" },
    });
  });

  // v3.4 Task 2: "Invite a friend" is now a single step (Decision 2) - one click sends
  // FRIEND_INVITE_GENERATE_CODE directly, no group to create first, and only the resulting
  // invite code renders.
  it("invites a friend: one click generates an invite code, with no group created first", async () => {
    mockSignedIn({
      FRIEND_INVITE_GENERATE_CODE: async () => ({
        ok: true,
        inviteCode: {
          code: "ABCD1234",
          createdBy: "user-a",
          expiresAt: new Date("2026-01-08T00:00:00Z").getTime(),
          usedBy: null,
        },
      }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByRole("button", { name: "Invite a friend" }));

    fireEvent.click(screen.getByRole("button", { name: "Invite a friend" }));

    expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "FRIEND_INVITE_GENERATE_CODE",
    });
    // Decision 2: no group is created any more - GROUP_CREATE no longer exists as a message
    // type, and this call site never sends it.
    expect(messenger.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "GROUP_CREATE" })
    );
  });

  it("adds a friend by invite code, then reloads the flat friends list", async () => {
    let friendsListCallCount = 0;
    mockSignedIn({
      FRIEND_REDEEM_CODE: async () => ({ ok: true, friendship: {} }),
      FRIENDS_LIST: async () => {
        friendsListCallCount += 1;
        return { ok: true, friendIds: friendsListCallCount === 1 ? [] : ["user-friend"] };
      },
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByLabelText("Invite code"));

    fireEvent.change(screen.getByLabelText("Invite code"), { target: { value: "code1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith({
        type: "FRIEND_REDEEM_CODE",
        payload: { code: "CODE1234" },
      })
    );
    // Reloads the flat friends list on success - the newly-added friend shows up without a
    // manual refresh.
    expect(await screen.findByText("user-friend")).toBeInTheDocument();
  });

  it("lists your flat friends list via FRIENDS_LIST on mount", async () => {
    mockSignedIn({
      FRIENDS_LIST: async () => ({ ok: true, friendIds: ["user-friend"] }),
    });

    render(<AccountPage />);

    expect(await screen.findByText("user-friend")).toBeInTheDocument();
  });

  it("shows a 'no friends yet' message when the friends list is empty", async () => {
    mockSignedIn({ FRIENDS_LIST: async () => ({ ok: true, friendIds: [] }) });

    render(<AccountPage />);

    expect(await screen.findByText(/no friends yet/i)).toBeInTheDocument();
  });

  // v3.4 Task 2: flat per-friend "Remove friend" action, replacing group-scoped "Leave". Either
  // party can unilaterally remove a friendship - no confirmation step (unlike the old group-leave
  // UI, which gated behind a two-click inline confirmation) since this is a single, easily
  // reversible relationship, not "leaving" a shared list that others also depend on.
  describe("removing a friend", () => {
    it("removes a friend via FRIEND_REMOVE and drops them from the rendered list", async () => {
      const removeSpy = vi.fn(async () => ({ ok: true }));
      mockSignedIn({
        FRIENDS_LIST: async () => ({ ok: true, friendIds: ["user-friend"] }),
        FRIEND_REMOVE: removeSpy,
      });

      render(<AccountPage />);
      await screen.findByText("user-friend");

      fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));

      await waitFor(() =>
        expect(removeSpy).toHaveBeenCalledWith({
          type: "FRIEND_REMOVE",
          payload: { friendUserId: "user-friend" },
        })
      );
      await waitFor(() => expect(screen.queryByText("user-friend")).not.toBeInTheDocument());
    });

    it("surfaces a server-side denial (e.g. not actually friends any more) as an error, without removing the row", async () => {
      mockSignedIn({
        FRIENDS_LIST: async () => ({ ok: true, friendIds: ["user-friend"] }),
        FRIEND_REMOVE: async () => ({ ok: false, error: "You aren't friends with this user." }),
      });

      render(<AccountPage />);
      await screen.findByText("user-friend");

      fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /you aren't friends with this user/i
      );
      expect(screen.getByText("user-friend")).toBeInTheDocument();
    });
  });

  it("signs out and returns to the signed-out view", async () => {
    mockSignedIn({
      AUTH_SIGN_OUT: async () => ({ ok: true }),
    });

    render(<AccountPage />);
    await waitFor(() => screen.getByText(/signed in as a@example.com/i));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

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

      fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
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
