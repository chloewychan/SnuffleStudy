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
