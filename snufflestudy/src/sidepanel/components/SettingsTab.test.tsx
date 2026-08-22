import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { SettingsTab } from "./SettingsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsTab", () => {
  it("renders TempPasscodePanel and UnlockRequestPanel (session=null), in the design's verified order", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, requests: [] });

    render(<SettingsTab />);

    // Structural check: two top-level sections directly under .sp-settings-tab.
    const sections = document.querySelectorAll(".sp-settings-tab > section");
    expect(sections.length).toBe(2);

    // Substantive check (beyond a bare mount-without-throwing smoke test): each section actually
    // renders its own panel's real heading text (read from source - TempPasscodePanel.tsx's
    // <h2>Temporary passcode requests</h2> and UnlockRequestPanel.tsx's <h2>Unlock requests</h2> -
    // not guessed), and in the order confirmed via get_design_context on nodeId=61:923 (the
    // "Passcode Requests" card shows "Temporary Requests" above "Unlock Requests" - see
    // SettingsTab.tsx's own comment for the full discrepancy note against the brief's literal
    // Step 4 sample order).
    const tempPasscodeHeading = within(sections[0] as HTMLElement).getByRole("heading", {
      name: /^temporary passcode requests$/i,
    });
    const unlockRequestsHeading = within(sections[1] as HTMLElement).getByRole("heading", {
      name: /^unlock requests$/i,
    });
    expect(tempPasscodeHeading).toBeInTheDocument();
    expect(unlockRequestsHeading).toBeInTheDocument();

    // Confirms session={null} was actually wired through to UnlockRequestPanel, not merely typed
    // that way and forgotten: with session=null, UnlockRequestPanel's "Request an unlock" section
    // (only rendered when isSessionActive, which requires a non-null session) must be absent -
    // only the "Requests from friends" approver section should render.
    expect(
      within(sections[1] as HTMLElement).queryByRole("heading", { name: /request an unlock/i })
    ).not.toBeInTheDocument();
    expect(
      within(sections[1] as HTMLElement).getByRole("heading", { name: /requests from friends/i })
    ).toBeInTheDocument();

    // Both composed panels fire their own real on-mount fetches (TEMP_PASSCODE_REQUESTS_FETCH
    // from TempPasscodePanel, UNLOCK_REQUESTS_FETCH from UnlockRequestPanel) rather than being
    // stubbed out - confirms this is a genuine composition, not two components that happen to
    // render static markup. Waiting for these also lets the panels' async state updates settle
    // before the test ends, avoiding act() warnings from updates that land after the assertions
    // above (the brief's own literal test sample didn't await these and produced such warnings).
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "TEMP_PASSCODE_REQUESTS_FETCH" })
      )
    );
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "UNLOCK_REQUESTS_FETCH" })
      )
    );
  });

  it("does not crash when the underlying requests fetches fail", async () => {
    // Both panels independently handle their own fetch failures (their own test suites cover the
    // exact error copy) - this only confirms composing them doesn't introduce a new failure mode,
    // e.g. an unhandled rejection or a thrown error, when every underlying call rejects.
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<SettingsTab />);

    await waitFor(() => {
      expect(screen.getByText(/couldn't load requests: network down/i)).toBeInTheDocument();
      expect(
        screen.getByText(/couldn't load unlock requests: network down/i)
      ).toBeInTheDocument();
    });
  });
});
