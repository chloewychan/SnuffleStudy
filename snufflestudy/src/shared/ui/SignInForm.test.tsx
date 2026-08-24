import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SignInForm } from "./SignInForm";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

// v3.2 Task 4: direct coverage for SignInForm's own edge-case handling (wrong/expired code,
// "Request a new code") — AccountPage.test.tsx and OnboardingWizard.test.tsx already exercise
// these indirectly through their call sites, but this file tests the shared component itself,
// independent of either host.

beforeEach(() => {
  vi.restoreAllMocks();
});

async function requestCode(email = "a@example.com") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
  await screen.findByLabelText("Code");
}

describe("SignInForm", () => {
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
    await requestCode();

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/token has expired or is invalid/i);
    // Doesn't advance: still on the code sub-view, onSignedIn never fires.
    expect(screen.getByLabelText("Code")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('shows a "Request a new code" button once a code has been requested, not before', async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(<SignInForm onSignedIn={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Request a new code" })).not.toBeInTheDocument();

    await requestCode();

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
    await requestCode("a@example.com");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "111111" } });
    expect(screen.getByLabelText("Code")).toHaveValue("111111");

    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_REQUEST_OTP",
        payload: { email: "a@example.com" },
      })
    );
    // Email is preserved (still shown in the "Check ... for a code" copy); the stale entered
    // code is cleared out since it was only ever valid against the previous OTP.
    expect(screen.getByText(/check a@example\.com for an 8-digit code/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveValue("");
  });

  it('"Request a new code" surfaces an error and leaves the entered code untouched on failure', async () => {
    let requestCount = 0;
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "AUTH_REQUEST_OTP") {
        requestCount += 1;
        // First request (initial) succeeds; the resend fails.
        return requestCount === 1 ? { ok: true } : { ok: false, error: "Too many requests" };
      }
      return { ok: true };
    });

    render(<SignInForm onSignedIn={vi.fn()} />);
    await requestCode("a@example.com");

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "222222" } });
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many requests/i);
    expect(screen.getByLabelText("Code")).toHaveValue("222222");
  });
});
