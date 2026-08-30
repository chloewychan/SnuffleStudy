import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsTab } from "./SettingsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import { HISTORY_LIST_LIMIT } from "../../options/pages/HistoryPage";

// v4.1 Task 10: SettingsTab.tsx no longer has a Settings/Account/Friends/History sub-nav - it
// renders SettingsPage, AccountPage, and HistoryPage as three stacked boxes in one scrolling view
// (scope doc's Settings section). These cases replace the old nav-switch coverage with assertions
// that all three boxes' own distinguishing content is present simultaneously on a single render,
// and that there is no Friends destination anywhere in this tab.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    runtime: {
      openOptionsPage: vi.fn(),
      // v4.2 Task 11: SettingsPage.tsx's Restricted Sites/Camera-and-microphone sections now
      // resolve icons via chrome.runtime.getURL (matches Header.test.tsx's identical stub, v4.2
      // Task 2) - this suite's own chrome stub replaces WXT's fake-browser test polyfill
      // entirely, so it needs its own getURL now that SettingsPage.tsx (rendered inside this
      // tab) actually calls it.
      getURL: vi.fn((path: string) => `/chrome-extension://fake/${path}`),
    },
  });
});

function mockAllSettled(overrides: Record<string, (message: any) => Promise<any>> = {}) {
  return vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
    const override = overrides[message.type];
    if (override) return override(message);
    if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
    if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
    if (message.type === "SESSION_LIST_HISTORY") return { ok: true, sessions: [] };
    return { ok: true };
  });
}

describe("SettingsTab", () => {
  it("renders Settings, Account, and History content all at once, with no sub-navigation", async () => {
    mockAllSettled();

    render(<SettingsTab />);

    expect(await screen.findByLabelText("Detailed site tracking")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(await screen.findByText("Session history")).toBeInTheDocument();

    // No sub-nav buttons of the old shape exist anymore.
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
  });

  it("never mounts a Friends destination anywhere in this tab", async () => {
    mockAllSettled();

    render(<SettingsTab />);
    await screen.findByLabelText("Detailed site tracking");

    // FriendsPage's own distinguishing copy/heading must never appear here - Friends management
    // now lives exclusively in the sidebar's own Friends tab (FriendsBox.tsx).
    expect(screen.queryByText(/choose what each friend can see/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Friends" })).not.toBeInTheDocument();
  });

  it("shows a button that opens the real Options tab for camera & microphone access, and no other full-tab navigation", async () => {
    mockAllSettled();

    render(<SettingsTab />);
    await screen.findByLabelText("Detailed site tracking");

    // v4.2 Task 11: this button now lives inside SettingsPage.tsx's own "Camera & Microphone"
    // section (Decision 7 - moved from the old sp-settings-tab__media-callout button, which this
    // task deleted). The Settings box still never shows the full permission-status flow inline
    // (mediaGrantStatus's granted/error states are OptionsApp.tsx's own still-inline, full-tab-
    // only section) - only this button, which just opens the real Options tab.
    expect(screen.queryByText(/you can close this tab now/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: /couldn't grant access/i })).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: /grant camera & microphone access/i });
    fireEvent.click(button);

    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  // QA-discovered bug (v3.3 QA pass): SettingsPage.tsx owns its own settings state, independent of
  // SidePanelApp.tsx's own top-level copy (used to start a session) - saving a change here never
  // told that copy to refresh. onSettingsChange is how SidePanelApp.tsx stays in sync; this proves
  // SettingsTab actually wires it through to SettingsPage's own onSettingsSaved callback.
  it("calls onSettingsChange with the updated settings after a change is saved", async () => {
    mockAllSettled({
      SETTINGS_GET: async () => ({
        ok: true,
        settings: { ...DEFAULT_USER_SETTINGS, defaultRestrictedSites: [] },
      }),
    });
    const onSettingsChange = vi.fn();

    render(<SettingsTab onSettingsChange={onSettingsChange} />);
    await screen.findByLabelText("Detailed site tracking");

    fireEvent.change(screen.getByLabelText("New restricted site"), {
      target: { value: "youtube.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({ defaultRestrictedSites: ["youtube.com"] })
      )
    );
  });

  it("fetches history via SESSION_LIST_HISTORY on render, without needing a tab switch", async () => {
    mockAllSettled();

    render(<SettingsTab />);
    await screen.findByLabelText("Detailed site tracking");

    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith({
        type: "SESSION_LIST_HISTORY",
        payload: { limit: HISTORY_LIST_LIMIT },
      })
    );
  });
});
