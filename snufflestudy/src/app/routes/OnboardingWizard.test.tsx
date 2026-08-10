import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as permissionsApi from "../../infrastructure/browser/permissionsApi";

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
});
