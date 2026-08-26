import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as permissionsApi from "../../infrastructure/browser/permissionsApi";
import * as contentScriptRegistration from "../../background/contentScriptRegistration";

beforeEach(() => {
  vi.restoreAllMocks();
});

function dismissWelcome() {
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
}

// The account (sign-in) step is the first step after Welcome as of v3.1; tests that exercise
// steps further down the flow skip it the same way a signed-out user would.
function skipAccountStep() {
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
}

function skipPasscodeStep() {
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
}

describe("OnboardingWizard", () => {
  it("shows the welcome screen before the first onboarding step", () => {
    render(<OnboardingWizard onComplete={vi.fn()} />);

    expect(screen.getByText(/consensual peer pressure/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Sign in to use friends, rooms, nudges, approvals/)
    ).not.toBeInTheDocument();

    dismissWelcome();

    expect(
      screen.getByText(/Sign in to use friends, rooms, nudges, approvals/)
    ).toBeInTheDocument();
  });

  it("walks through all steps and saves settings on completion", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    const onComplete = vi.fn();

    render(<OnboardingWizard onComplete={onComplete} />);

    dismissWelcome();
    skipAccountStep(); // account -> name
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking (activity-only default) -> passcode
    skipPasscodeStep(); // passcode -> review
    fireEvent.click(screen.getByRole("button", { name: "Start using SnuffleStudy" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SETTINGS_SAVE",
          payload: expect.objectContaining({ onboardingCompleted: true, trackingTier: "activity-only" }),
        })
      )
    );
    expect(onComplete).toHaveBeenCalled();
    // Skipping the passcode step must not send a HARD_BLOCK_SET_PASSCODE message.
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "HARD_BLOCK_SET_PASSCODE" })
    );
  });

  it("requests detailed tracking permission and shows the site-list step when chosen", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);

    render(<OnboardingWizard onComplete={vi.fn()} />);

    dismissWelcome();
    skipAccountStep(); // account -> name
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Restricted sites")).toBeInTheDocument();
  });

  it("inserts the passcode step after the site-list step when detailed tracking was chosen", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);

    render(<OnboardingWizard onComplete={vi.fn()} />);

    dismissWelcome();
    skipAccountStep(); // account -> name
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> sites
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // sites -> passcode

    expect(screen.getByText("Set a hard-block passcode (optional)")).toBeInTheDocument();
  });

  it("registers the overlay content script after granting detailed tracking permission and finishing", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);
    const registerSpy = vi
      .spyOn(contentScriptRegistration, "registerOverlayContentScript")
      .mockResolvedValue(undefined);
    const onComplete = vi.fn();

    render(<OnboardingWizard onComplete={onComplete} />);

    dismissWelcome();
    skipAccountStep(); // account -> name
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> sites
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // sites -> passcode
    skipPasscodeStep(); // passcode -> review

    fireEvent.click(screen.getByRole("button", { name: "Start using SnuffleStudy" }));

    await waitFor(() => expect(registerSpy).toHaveBeenCalled());
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("still completes onboarding even if registering the overlay content script fails", async () => {
    // registerOverlayContentScript (chrome.scripting.registerContentScripts) failing is a
    // best-effort/non-critical failure — it must not block onboarding completion, which is
    // the part the user actually asked for and already granted the permission dialog for.
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);
    vi.spyOn(contentScriptRegistration, "registerOverlayContentScript").mockRejectedValue(
      new Error("scripting.registerContentScripts not implemented")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onComplete = vi.fn();

    render(<OnboardingWizard onComplete={onComplete} />);

    dismissWelcome();
    skipAccountStep(); // account -> name
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> sites
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // sites -> passcode
    skipPasscodeStep(); // passcode -> review

    fireEvent.click(screen.getByRole("button", { name: "Start using SnuffleStudy" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(sendMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SETTINGS_SAVE",
        payload: expect.objectContaining({ trackingTier: "detailed" }),
      })
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("surfaces an error and does not call onComplete when saving settings fails", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockRejectedValue(new Error("Could not establish connection"));
    const onComplete = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<OnboardingWizard onComplete={onComplete} />);

    dismissWelcome();
    skipAccountStep(); // account -> name
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> passcode
    skipPasscodeStep(); // passcode -> review

    fireEvent.click(screen.getByRole("button", { name: "Start using SnuffleStudy" }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalled());

    // (a) no unhandled rejection surfaces / component doesn't crash — implied by these
    // assertions succeeding, since vitest fails the test on unhandled rejections.
    // (b) onComplete must not fire — the save failed.
    await waitFor(() => expect(onComplete).not.toHaveBeenCalled());

    // (c) an error indication is visible to the user.
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  // v3.2 Task 3: the account (sign-in) step was added in v3.1 without test coverage — these
  // cases exercise it directly against the shared SignInForm (v3.2 Task 1), the same way the
  // other steps below are already covered.
  describe("account (sign-in) step", () => {
    it("renders the exact framing copy", () => {
      render(<OnboardingWizard onComplete={vi.fn()} />);
      dismissWelcome();

      expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      expect(
        screen.getByText(
          "Sign in to use friends, rooms, nudges, approvals, and synced accountability features."
        )
      ).toBeInTheDocument();
    });

    it('advances to "name" via "Skip for now" without calling any AUTH_* message', () => {
      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

      render(<OnboardingWizard onComplete={vi.fn()} />);
      dismissWelcome();

      skipAccountStep();

      expect(screen.getByText("Meet Snuffles")).toBeInTheDocument();
      expect(
        sendMessageSpy.mock.calls.some(
          ([message]) => typeof message?.type === "string" && message.type.startsWith("AUTH_")
        )
      ).toBe(false);
    });

    // v3.3 Task 14: SignInForm now splits into a top-level Create account/Sign in choice
    // (Decision 6). These two tests route through the Sign in branch's "Email me a code" option
    // - the unchanged round trip that still calls onSignedIn directly with no password step, the
    // closest analog to what they covered before the split. SignInForm.test.tsx and
    // AccountPage.test.tsx's "creating a new account" block cover the create-account branch's
    // mandatory password step directly.
    it('advances to "name" after a successful AUTH_REQUEST_OTP -> AUTH_VERIFY_OTP round trip via "Email me a code"', async () => {
      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
        async (message: any) => {
          if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
          if (message.type === "AUTH_VERIFY_OTP") {
            return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
          }
          return { ok: true };
        }
      );

      render(<OnboardingWizard onComplete={vi.fn()} />);
      dismissWelcome();

      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));

      await screen.findByLabelText("Code");
      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

      expect(await screen.findByText("Meet Snuffles")).toBeInTheDocument();
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_REQUEST_OTP",
        payload: { email: "a@example.com" },
      });
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_VERIFY_OTP",
        payload: { email: "a@example.com", token: "12345678" },
      });
    });

    it("shows the error and stays on the account step when AUTH_VERIFY_OTP fails", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        if (message.type === "AUTH_VERIFY_OTP") {
          return { ok: false, error: "Token has expired or is invalid" };
        }
        return { ok: true };
      });

      render(<OnboardingWizard onComplete={vi.fn()} />);
      dismissWelcome();

      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));

      await screen.findByLabelText("Code");
      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "00000000" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/token has expired or is invalid/i);
      expect(screen.queryByText("Meet Snuffles")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    });

    // v3.3 Task 14 DoD: "'Skip for now' in onboarding still fully skips, at any point in either
    // branch, with no partial state blocking a later attempt." — covered in depth at the
    // component level by SignInForm.test.tsx; this is the one end-to-end check from the actual
    // OnboardingWizard call site.
    //
    // v3.4 Task 7 rewrote this test: the create-account branch's separate "set a password after
    // verification" step is gone - AUTH_SET_PASSWORD now fires automatically the instant
    // AUTH_VERIFY_OTP succeeds (see SignInForm.tsx's completeAccountCreation), so there's no
    // longer a manual post-verification step for Skip to escape from before AUTH_SET_PASSWORD
    // sends. The equivalent "most at risk of trapping onSkip" moment in the new flow is a
    // *completion failure* (AUTH_SET_PASSWORD rejected) leaving the user on "create-code" with a
    // Retry button instead of advancing automatically - Skip must still cleanly escape from
    // there too.
    it('"Skip for now" still escapes the create-account branch after a completion failure leaves a Retry button showing', async () => {
      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
        async (message: any) => {
          if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
          if (message.type === "AUTH_VERIFY_OTP") {
            return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
          }
          if (message.type === "AUTH_SET_PASSWORD") {
            return { ok: false, error: "Network error" };
          }
          return { ok: true };
        }
      );

      render(<OnboardingWizard onComplete={vi.fn()} />);
      dismissWelcome();

      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Robin" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
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

      // Completion failed automatically after verification - a Retry button is showing in place
      // of a fresh "Verify code" submit. Skip must still work from here.
      await screen.findByRole("button", { name: "Retry" });
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "AUTH_SET_PASSWORD" })
      );

      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

      expect(screen.getByText("Meet Snuffles")).toBeInTheDocument();
    });
  });

  describe("optional passcode step", () => {
    async function reachPasscodeStep() {
      render(<OnboardingWizard onComplete={vi.fn()} />);
      dismissWelcome();
      skipAccountStep(); // account -> name
      fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
      fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
      fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking
      fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> passcode
    }

    it("disables the Set passcode button until the passcode has at least 4 characters", async () => {
      vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
      await reachPasscodeStep();

      const setButton = screen.getByRole("button", { name: "Set passcode" });
      expect(setButton).toBeDisabled();

      fireEvent.change(screen.getByTestId("onboarding-passcode-input"), {
        target: { value: "123" },
      });
      expect(setButton).toBeDisabled();

      fireEvent.change(screen.getByTestId("onboarding-passcode-input"), {
        target: { value: "1234" },
      });
      expect(setButton).not.toBeDisabled();
    });

    it("sets a passcode via HARD_BLOCK_SET_PASSCODE and advances to review", async () => {
      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
      await reachPasscodeStep();

      fireEvent.change(screen.getByTestId("onboarding-passcode-input"), {
        target: { value: "1234" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set passcode" }));

      await waitFor(() =>
        expect(sendMessageSpy).toHaveBeenCalledWith({
          type: "HARD_BLOCK_SET_PASSCODE",
          payload: { passcode: "1234" },
        })
      );
      expect(await screen.findByText("Ready to go")).toBeInTheDocument();
    });

    it("skips the passcode step without sending HARD_BLOCK_SET_PASSCODE and does not block completion", async () => {
      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
      await reachPasscodeStep();

      skipPasscodeStep();

      expect(screen.getByText("Ready to go")).toBeInTheDocument();
      expect(sendMessageSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "HARD_BLOCK_SET_PASSCODE" })
      );
    });

    it("surfaces an error and stays on the passcode step when saving the passcode fails", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "HARD_BLOCK_SET_PASSCODE") {
          return { ok: false, error: "Incorrect current passcode." };
        }
        return { ok: true };
      });
      await reachPasscodeStep();

      fireEvent.change(screen.getByTestId("onboarding-passcode-input"), {
        target: { value: "1234" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set passcode" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/Incorrect current passcode/);
      expect(screen.queryByText("Ready to go")).not.toBeInTheDocument();
    });

    it("surfaces an error via console/alert and does not crash when the passcode save rejects", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "HARD_BLOCK_SET_PASSCODE") {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { ok: true };
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await reachPasscodeStep();

      fireEvent.change(screen.getByTestId("onboarding-passcode-input"), {
        target: { value: "1234" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set passcode" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(screen.queryByText("Ready to go")).not.toBeInTheDocument();
    });
  });
});
