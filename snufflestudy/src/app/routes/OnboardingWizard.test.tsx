import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as permissionsApi from "../../infrastructure/browser/permissionsApi";
import * as contentScriptRegistration from "../../background/contentScriptRegistration";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OnboardingWizard", () => {
  it("walks through all steps and saves settings on completion", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    const onComplete = vi.fn();

    render(<OnboardingWizard onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking (activity-only default) -> review
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
  });

  it("requests detailed tracking permission and shows the site-list step when chosen", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);

    render(<OnboardingWizard onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Restricted sites")).toBeInTheDocument();
  });

  it("registers the overlay content script after granting detailed tracking permission and finishing", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);
    const registerSpy = vi
      .spyOn(contentScriptRegistration, "registerOverlayContentScript")
      .mockResolvedValue(undefined);
    const onComplete = vi.fn();

    render(<OnboardingWizard onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> sites
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // sites -> review

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

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> sites
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // sites -> review

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

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking -> review

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
});
