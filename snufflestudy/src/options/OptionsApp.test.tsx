import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OptionsApp } from "./OptionsApp";
import * as messenger from "../infrastructure/messaging/extensionMessenger";
import * as permissionsApi from "../infrastructure/browser/permissionsApi";
import { DEFAULT_USER_SETTINGS } from "../domain/settings/userSettings";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OptionsApp", () => {
  it("requests detailed tracking permission when the user selects it", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, settings: DEFAULT_USER_SETTINGS });
    const requestSpy = vi
      .spyOn(permissionsApi, "requestDetailedTrackingPermission")
      .mockResolvedValue(true);

    render(<OptionsApp />);
    await waitFor(() => screen.getByLabelText("Detailed site tracking"));

    fireEvent.click(screen.getByLabelText("Detailed site tracking"));

    await waitFor(() => expect(requestSpy).toHaveBeenCalled());
  });

  it("saves a hard-block passcode", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, settings: DEFAULT_USER_SETTINGS });
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage");

    render(<OptionsApp />);
    await waitFor(() => screen.getByPlaceholderText(/passcode/i) || screen.getByLabelText(/passcode/i));

    fireEvent.change(screen.getByTestId("passcode-input"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save passcode" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "HARD_BLOCK_SET_PASSCODE",
        payload: { passcode: "1234" },
      })
    );
  });

  it("surfaces an error instead of hanging on Loading… when the initial settings fetch rejects", async () => {
    // sendMessage (chrome.runtime.sendMessage) can reject — e.g. during service-worker
    // startup races or extension-context-invalidated. The whole page is gated behind this
    // call succeeding, so it must not be left stuck on "Loading…" forever with no signal.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );

    render(<OptionsApp />);

    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("rolls back to the previous tracking tier and surfaces an error when the save fails", async () => {
    // updateSettings applies an optimistic UI update before the save is confirmed. If the
    // SETTINGS_SAVE call then rejects, the UI must not keep showing the unsaved change as if
    // it took — it should revert to what's actually persisted and say so.
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "SETTINGS_SAVE") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true };
    });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<OptionsApp />);
    await waitFor(() => screen.getByLabelText("Detailed site tracking"));

    fireEvent.click(screen.getByLabelText("Detailed site tracking"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);

    // Reverted to the previously-persisted tier — the save never actually took, so the UI
    // must not keep claiming the switch to "detailed" succeeded.
    expect(screen.getByLabelText("Activity-only")).toBeChecked();
    expect(screen.getByLabelText("Detailed site tracking")).not.toBeChecked();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("rolls back the restricted-sites list and surfaces an error when the save fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "SETTINGS_SAVE") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true };
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<OptionsApp />);
    const textarea = await waitFor(() => screen.getByLabelText(/Default restricted sites/i));

    fireEvent.change(textarea, { target: { value: "example.com" } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(textarea).toHaveValue(DEFAULT_USER_SETTINGS.defaultRestrictedSites.join("\n"));
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("surfaces an error and does not crash when saving the passcode fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "HARD_BLOCK_SET_PASSCODE") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true };
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<OptionsApp />);
    await waitFor(() => screen.getByTestId("passcode-input"));

    fireEvent.change(screen.getByTestId("passcode-input"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save passcode" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();

    // The passcode was never actually saved, so the input must not be silently cleared as if
    // it succeeded — the user's typed value stays visible.
    expect(screen.getByTestId("passcode-input")).toHaveValue("1234");
    expect(screen.getByRole("button", { name: "Save passcode" })).not.toBeDisabled();
  });
});
