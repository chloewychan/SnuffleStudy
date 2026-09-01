import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import { RefreshRegistryProvider } from "../../sidepanel/refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
  // design-specs/frames/page-welcome.json: WelcomeScreen now renders the real Header, which
  // needs chrome.runtime.getURL (mascot image, ButtonIcon glyphs) and an AUTH_GET_SESSION
  // response - every test below sets its own sendMessage mock afterward, all of which fall
  // through to { ok: true } for unlisted message types, satisfying this the same way.
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path: string) => `/chrome-extension://fake/${path}`),
    },
  });
});

function renderWizard(onComplete: () => void = () => {}) {
  return render(
    <RefreshRegistryProvider>
      <OnboardingWizard onComplete={onComplete} />
    </RefreshRegistryProvider>
  );
}

function dismissWelcome() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

// The account (sign-in) step is the first (and, as of v4.1 Task 3, only) step after Welcome;
// tests that don't care about sign-in itself skip it the same way a signed-out user would.
function skipAccountStep() {
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
}

describe("OnboardingWizard", () => {
  it("shows the welcome screen before the first onboarding step", () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderWizard();

    expect(screen.getByText(/consensual peer pressure/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Sign in to use friends, rooms, nudges, approvals/)
    ).not.toBeInTheDocument();

    dismissWelcome();

    expect(
      screen.getByText(/Sign in to use friends, rooms, nudges, approvals/)
    ).toBeInTheDocument();
  });

  // v4.1 Task 3: onboarding no longer collects pressure style/duration/tracking tier/restricted
  // sites/passcode - "Skip for now" on the account step now finishes onboarding directly with
  // fixed defaults instead of advancing to another step.
  it("finishes onboarding with fixed defaults after 'Skip for now'", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    const onComplete = vi.fn();

    renderWizard(onComplete);

    dismissWelcome();
    skipAccountStep();

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SETTINGS_SAVE",
        payload: {
          pressureProfileId: "gentle-encouragement",
          trackingTier: "activity-only",
          activityTrackingEnabled: true,
          defaultFocusDurationSeconds: 1500,
          defaultBreakDurationSeconds: 300,
          defaultAllowedSites: [],
          defaultRestrictedSites: [],
          defaultRestrictionMode: "soft",
          onboardingCompleted: true,
          friendSyncEnabled: false,
          liveNudgesNotificationsEnabled: true,
          digestNotificationsEnabled: true,
          quietHours: null,
        },
      })
    );
    expect(onComplete).toHaveBeenCalled();
    // No passcode step exists anymore - skipping must not send a HARD_BLOCK_SET_PASSCODE message.
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "HARD_BLOCK_SET_PASSCODE" })
    );
  });

  // v4.1 Task 3 DoD: "TASK_LIST shows one task titled 'Study with Snuffles'."
  it("finishing onboarding creates the default 'Study with Snuffles' task", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    const onComplete = vi.fn();

    renderWizard(onComplete);

    dismissWelcome();
    skipAccountStep();

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "TASK_CREATE",
        payload: { title: "Study with Snuffles" },
      })
    );
    // The default task is seeded after settings are saved, and onComplete still fires.
    const settingsSaveIndex = sendMessageSpy.mock.calls.findIndex(
      ([message]) => message.type === "SETTINGS_SAVE"
    );
    const taskCreateIndex = sendMessageSpy.mock.calls.findIndex(
      ([message]) => message.type === "TASK_CREATE"
    );
    expect(settingsSaveIndex).toBeGreaterThanOrEqual(0);
    expect(taskCreateIndex).toBeGreaterThan(settingsSaveIndex);
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  // A failure seeding the default task is best-effort - logged, but must not block completion.
  it("still completes onboarding if seeding the default task fails", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      async (message: any) => {
        if (message.type === "TASK_CREATE") {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { ok: true };
      }
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onComplete = vi.fn();

    renderWizard(onComplete);

    dismissWelcome();
    skipAccountStep();

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TASK_CREATE" })
    ));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("surfaces an error and does not call onComplete when saving settings fails", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockRejectedValue(new Error("Could not establish connection"));
    const onComplete = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWizard(onComplete);

    dismissWelcome();
    skipAccountStep();

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
      vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
      renderWizard();
      dismissWelcome();

      expect(screen.getByRole("heading", { name: "Sign In" })).toBeInTheDocument();
      expect(
        screen.getByText(
          "Sign in to use friends, rooms, nudges, approvals, and synced accountability features."
        )
      ).toBeInTheDocument();
    });

    it('finishes onboarding via "Skip for now" without calling any auth-flow message', async () => {
      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
      const onComplete = vi.fn();

      renderWizard(onComplete);
      dismissWelcome();

      skipAccountStep();

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      // AUTH_GET_SESSION is excluded here - it's Header.tsx's own passive on-mount check
      // (design-specs/frames/page-welcome.json now renders the real header-bar), not part of a
      // sign-in flow. The flow-driving AUTH_* messages (request/verify OTP, sign in, set
      // password) are what this assertion cares about never firing on a skip.
      expect(
        sendMessageSpy.mock.calls.some(
          ([message]) =>
            typeof message?.type === "string" &&
            message.type.startsWith("AUTH_") &&
            message.type !== "AUTH_GET_SESSION"
        )
      ).toBe(false);
    });

    // v3.3 Task 14: SignInForm now splits into a top-level Create account/Sign in choice
    // (Decision 6). These two tests route through the Sign in branch's "Email me a code" option
    // - the unchanged round trip that still calls onSignedIn directly with no password step, the
    // closest analog to what they covered before the split. SignInForm.test.tsx and
    // AccountPage.test.tsx's "creating a new account" block cover the create-account branch's
    // mandatory password step directly.
    it('finishes onboarding after a successful AUTH_REQUEST_OTP -> AUTH_VERIFY_OTP round trip via "Sign in (one-time code)"', async () => {
      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
        async (message: any) => {
          if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
          if (message.type === "AUTH_VERIFY_OTP") {
            return { ok: true, session: { user: { id: "user-a", email: "a@example.com" } } };
          }
          return { ok: true };
        }
      );
      const onComplete = vi.fn();

      renderWizard(onComplete);
      dismissWelcome();

      fireEvent.click(screen.getByRole("button", { name: "Sign in (one-time code)" }));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send Sign-In Code" }));

      await screen.findByLabelText("Code");
      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_REQUEST_OTP",
        payload: { email: "a@example.com" },
      });
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "AUTH_VERIFY_OTP",
        payload: { email: "a@example.com", token: "12345678" },
      });
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SETTINGS_SAVE" })
      );
    });

    it("shows the error and stays on the account step when AUTH_VERIFY_OTP fails", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
        if (message.type === "AUTH_REQUEST_OTP") return { ok: true };
        if (message.type === "AUTH_VERIFY_OTP") {
          return { ok: false, error: "Token has expired or is invalid" };
        }
        return { ok: true };
      });

      renderWizard();
      dismissWelcome();

      fireEvent.click(screen.getByRole("button", { name: "Sign in (one-time code)" }));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send Sign-In Code" }));

      await screen.findByLabelText("Code");
      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "00000000" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/token has expired or is invalid/i);
      expect(screen.getByRole("heading", { name: "Sign In With One-Time Code" })).toBeInTheDocument();
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
      const onComplete = vi.fn();

      renderWizard(onComplete);
      dismissWelcome();

      fireEvent.click(screen.getByRole("button", { name: "Create new account" }));
      fireEvent.change(screen.getByLabelText("Your Name"), { target: { value: "Robin" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "correct-horse" },
      });
      fireEvent.change(screen.getByLabelText("Confirm Password"), {
        target: { value: "correct-horse" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send Sign-In Code" }));
      await screen.findByLabelText("Code");
      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "12345678" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));

      // Completion failed automatically after verification - a Retry button is showing in place
      // of a fresh "Verify Code" submit. Skip must still work from here.
      await screen.findByRole("button", { name: "Retry" });
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "AUTH_SET_PASSWORD" })
      );

      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
    });
  });
});
