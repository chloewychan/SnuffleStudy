import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsTab } from "./SettingsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import { HISTORY_LIST_LIMIT } from "../../options/pages/HistoryPage";

// v3.3 Task 7: SettingsTab.tsx was an empty placeholder (Task 1) - these cases cover the new
// four-way Settings/Account/Friends/History sub-nav it was rebuilt into, mirroring
// OptionsApp.test.tsx's own nav-switch coverage for the same underlying pages/components.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    runtime: {
      openOptionsPage: vi.fn(),
    },
  });
});

describe("SettingsTab", () => {
  it("defaults to the Settings view, rendering SettingsPage content", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, settings: DEFAULT_USER_SETTINGS });

    render(<SettingsTab />);

    expect(await screen.findByLabelText("Detailed site tracking")).toBeInTheDocument();
    // No other view's content is present. (SettingsPage itself has its own <h2>Friends</h2>
    // section - share-activity settings, not FriendsPage - so this checks FriendsPage's own
    // distinguishing copy rather than the ambiguous "Friends" heading text.)
    expect(screen.queryByRole("heading", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.queryByText(/choose what each friend can see/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Session history")).not.toBeInTheDocument();
  });

  it("shows a callout that opens the real Options tab for camera & microphone access, and no other full-tab navigation", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, settings: DEFAULT_USER_SETTINGS });

    render(<SettingsTab />);
    await screen.findByLabelText("Detailed site tracking");

    // The Settings view itself never shows the camera/microphone section inline (that's the one
    // deliberate exception - see OptionsApp.tsx's still-inline section) - only the callout button.
    expect(screen.queryByRole("heading", { name: /camera.*microphone/i })).not.toBeInTheDocument();

    const callout = screen.getByRole("button", { name: /grant camera & microphone access/i });
    fireEvent.click(callout);

    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  it("switches to the Account view and back to Settings", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SettingsTab />);
    await screen.findByLabelText("Detailed site tracking");

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Detailed site tracking")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith({ type: "AUTH_GET_SESSION" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByLabelText("Detailed site tracking")).toBeInTheDocument();
  });

  it("switches to the Friends view, and its Sign in link routes back to Account (onSignInClick wiring)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SettingsTab />);
    await screen.findByLabelText("Detailed site tracking");

    fireEvent.click(screen.getByRole("button", { name: "Friends" }));

    expect(await screen.findByRole("heading", { name: "Friends" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Detailed site tracking")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
  });

  it("switches to the History view", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "SESSION_LIST_HISTORY") return { ok: true, sessions: [] };
      return { ok: true };
    });

    render(<SettingsTab />);
    await screen.findByLabelText("Detailed site tracking");

    fireEvent.click(screen.getByRole("button", { name: "History" }));

    expect(await screen.findByText("Session history")).toBeInTheDocument();
    expect(screen.queryByLabelText("Detailed site tracking")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith({
        type: "SESSION_LIST_HISTORY",
        payload: { limit: HISTORY_LIST_LIMIT },
      })
    );
  });
});
