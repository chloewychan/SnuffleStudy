import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SignInForm } from "./SignInForm";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

// v3.3 Task 14: SignInForm now splits into a top-level Create account/Sign in choice (Decision
// 6 - this lives in the component itself, not a caller-supplied prop). This file was rewritten
// for that branch structure; the pre-Task-14 "one flow does everything" tests it used to have
// (v3.2 Task 4) are now split across the create-account branch (mandatory password step) and the
// sign-in branch's "Email me a code" option (unchanged round trip, still calls onSignedIn
// directly, still covers wrong/expired code + resend).

beforeEach(() => {
  vi.restoreAllMocks();
});

function goToCreateAccount() {
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

function goToSignInWithCode() {
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
}

function goToSignInWithPassword() {
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign in with a password" }));
}

async function requestCreateCode(email = "a@example.com") {
  goToCreateAccount();
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
  await screen.findByLabelText("Code");
}

async function requestSignInCode(email = "a@example.com") {
  goToSignInWithCode();
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
  await screen.findByLabelText("Code");
}

describe("SignInForm — entry choice", () => {
  it("shows Create account / Sign in as the entry state, with no email field visible yet", () => {
    render(<SignInForm onSignedIn={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("Sign in reveals two peer options: password or a code", () => {
    render(<SignInForm onSignedIn={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("button", { name: "Sign in with a password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeInTheDocument();
  });
});

describe("SignInForm — create-account branch", () => {
  it("cannot complete account creation without both a verified code and matching passwords (disabled submit, not just visual)", async () => {
    const onSignedIn = vi.fn();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={onSignedIn} />);
    await requestCreateCode();

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    const passwordInput = await screen.findByLabelText("Password");
    const confirmInput = screen.getByLabelText("Confirm password");
    const submitButton = screen.getByRole("button", { name: "Set password" });

    // Nothing typed yet: genuinely disabled.
    expect(submitButton).toBeDisabled();

    fireEvent.change(passwordInput, { target: { value: "correct-horse-battery" } });
    // Only one field filled: still genuinely disabled.
    expect(submitButton).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: "does-not-match" } });
    // Both filled but mismatched: still genuinely disabled.
    expect(submitButton).toBeDisabled();
    expect(onSignedIn).not.toHaveBeenCalled();

    fireEvent.change(confirmInput, { target: { value: "correct-horse-battery" } });
    // Matching: now enabled.
    expect(submitButton).not.toBeDisabled();
  });

  it("a brand-new email completes Create account only after code verification AND AUTH_SET_PASSWORD both succeed", async () => {
    const onSignedIn = vi.fn();
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(async (message: any) => {
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        if (message.type === "AUTH_VERIFY_OTP") {
          return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
        }
        if (message.type === "AUTH_SET_PASSWORD") return { ok: true };
        return { ok: true };
      });

    render(<SignInForm onSignedIn={onSignedIn} />);
    await requestCreateCode("new@example.com");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    await screen.findByLabelText("Password");
    // onSignedIn must NOT fire on a bare verified code - the password step is mandatory.
    expect(onSignedIn).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_SET_PASSWORD",
        payload: { password: "correct-horse" },
      })
    );
    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith({
        user: { id: "user-a", email: "a@example.com" },
      })
    );
  });

  it("surfaces an AUTH_SET_PASSWORD failure without calling onSignedIn", async () => {
    const onSignedIn = vi.fn();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
      }
      if (message.type === "AUTH_SET_PASSWORD") {
        return { ok: false, error: "Password should be at least 6 characters" };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={onSignedIn} />);
    await requestCreateCode();
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    await screen.findByLabelText("Password");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /password should be at least 6 characters/i
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("surfaces an inline error when the create-account code is wrong or expired, and does not advance to the password step", async () => {
    const onSignedIn = vi.fn();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: false, error: "Token has expired or is invalid" };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={onSignedIn} />);
    await requestCreateCode();

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "00000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/token has expired or is invalid/i);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('"Skip for now" fully skips at every step of the create-account branch when onSkip is provided', async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
      }
      return { ok: true };
    });

    // Skip from the very entry choice.
    const onSkip1 = vi.fn();
    const { unmount: unmount1 } = render(<SignInForm onSignedIn={vi.fn()} onSkip={onSkip1} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip1).toHaveBeenCalledTimes(1);
    unmount1();

    // Skip from the create-account email step.
    const onSkip2 = vi.fn();
    const { unmount: unmount2 } = render(<SignInForm onSignedIn={vi.fn()} onSkip={onSkip2} />);
    goToCreateAccount();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip2).toHaveBeenCalledTimes(1);
    unmount2();

    // Skip from the create-account code step.
    const onSkip3 = vi.fn();
    const { unmount: unmount3 } = render(<SignInForm onSignedIn={vi.fn()} onSkip={onSkip3} />);
    await requestCreateCode();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip3).toHaveBeenCalledTimes(1);
    unmount3();

    // Skip from the create-account password step.
    const onSkip4 = vi.fn();
    render(<SignInForm onSignedIn={vi.fn()} onSkip={onSkip4} />);
    await requestCreateCode();
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await screen.findByLabelText("Password");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip4).toHaveBeenCalledTimes(1);
  });

  it("omits Skip for now entirely outside the onboarding context (no onSkip prop)", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    render(<SignInForm onSignedIn={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Skip for now" })).not.toBeInTheDocument();
    goToCreateAccount();
    expect(screen.queryByRole("button", { name: "Skip for now" })).not.toBeInTheDocument();
  });
});

describe("SignInForm — sign-in branch: password option", () => {
  it("signs in with email + password via AUTH_SIGN_IN_PASSWORD, reaching a real session shape", async () => {
    const onSignedIn = vi.fn();
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(async (message: any) => {
        if (message.type === "AUTH_SIGN_IN_PASSWORD") {
          return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
        }
        return { ok: true };
      });

    render(<SignInForm onSignedIn={onSignedIn} />);
    goToSignInWithPassword();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22-plus" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_SIGN_IN_PASSWORD",
        payload: { email: "a@example.com", password: "hunter22-plus" },
      })
    );
    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith({
        user: { id: "user-a", email: "a@example.com" },
      })
    );
  });

  it("surfaces a wrong-password error and does not call onSignedIn", async () => {
    const onSignedIn = vi.fn();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_SIGN_IN_PASSWORD") {
        return { ok: false, error: "Invalid login credentials" };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={onSignedIn} />);
    goToSignInWithPassword();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid login credentials/i);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("disables submit until both email and password are entered", () => {
    render(<SignInForm onSignedIn={vi.fn()} />);
    goToSignInWithPassword();

    const submitButton = screen.getByRole("button", { name: "Sign in" });
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    expect(submitButton).not.toBeDisabled();
  });
});

describe("SignInForm — sign-in branch: code option (unchanged OTP round trip)", () => {
  it("verifying a code calls onSignedIn directly, with no password step tacked on", async () => {
    const onSignedIn = vi.fn();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={onSignedIn} />);
    await requestSignInCode();

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith({
        user: { id: "user-a", email: "a@example.com" },
      })
    );
    // No password fields ever appear on this path.
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("surfaces an inline error when the code is wrong or expired, and does not sign in", async () => {
    const onSignedIn = vi.fn();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
      if (message.type === "AUTH_VERIFY_OTP") {
        return { ok: false, error: "Token has expired or is invalid" };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={onSignedIn} />);
    await requestSignInCode();

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "00000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/token has expired or is invalid/i);
    expect(screen.getByLabelText("Code")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('shows a "Request a new code" button once a code has been requested, not before', async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(<SignInForm onSignedIn={vi.fn()} />);
    goToSignInWithCode();

    expect(screen.queryByRole("button", { name: "Request a new code" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    await screen.findByLabelText("Code");

    expect(screen.getByRole("button", { name: "Request a new code" })).toBeInTheDocument();
  });

  it('"Request a new code" re-fires AUTH_REQUEST_OTP for the same email and clears the entered code', async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(async (message: any) => {
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        return { ok: true };
      });

    render(<SignInForm onSignedIn={vi.fn()} />);
    await requestSignInCode("a@example.com");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "11111111" } });
    expect(screen.getByLabelText("Code")).toHaveValue("11111111");

    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_REQUEST_OTP",
        payload: { email: "a@example.com" },
      })
    );
    expect(screen.getByText(/check a@example\.com for an 8-digit code/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveValue("");
  });

  it('"Request a new code" surfaces an error and leaves the entered code untouched on failure', async () => {
    let requestCount = 0;
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") {
        requestCount += 1;
        return requestCount === 1 ? { ok: true } : { ok: false, error: "Too many requests" };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={vi.fn()} />);
    await requestSignInCode("a@example.com");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "22222222" } });
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many requests/i);
    expect(screen.getByLabelText("Code")).toHaveValue("22222222");
  });

  it('"Skip for now" fully skips at every step of the sign-in branch when onSkip is provided', async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    const onSkip1 = vi.fn();
    const { unmount: unmount1 } = render(<SignInForm onSignedIn={vi.fn()} onSkip={onSkip1} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip1).toHaveBeenCalledTimes(1);
    unmount1();

    const onSkip2 = vi.fn();
    const { unmount: unmount2 } = render(<SignInForm onSignedIn={vi.fn()} onSkip={onSkip2} />);
    goToSignInWithPassword();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip2).toHaveBeenCalledTimes(1);
    unmount2();

    const onSkip3 = vi.fn();
    render(<SignInForm onSignedIn={vi.fn()} onSkip={onSkip3} />);
    await requestSignInCode();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip3).toHaveBeenCalledTimes(1);
  });
});
