import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { Header } from "./Header";
import { RefreshRegistryProvider, useRefreshAll } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

// v4.1 Task 2: Header now reads useRefreshAll(), which throws outside a
// RefreshRegistryProvider - every render() below needs one as an ancestor.
function renderHeader(onSignInClick: () => void = () => {}) {
  return render(
    <RefreshRegistryProvider>
      <Header onSignInClick={onSignInClick} />
    </RefreshRegistryProvider>
  );
}

describe("Header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: vi.fn((path: string) => `/chrome-extension://fake/${path}`),
      },
    });
  });

  it("shows a Log-In button when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderHeader();
    expect(await screen.findByRole("button", { name: /log in/i })).toBeInTheDocument();
  });

  it("hides the Log-In button when signed in", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: { user: { id: "user-1" } },
    });
    renderHeader();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /log in/i })).not.toBeInTheDocument()
    );
  });

  it("calls onSignInClick (navigating within the side panel) when Log-In is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    const onSignInClick = vi.fn();
    renderHeader(onSignInClick);
    const button = await screen.findByRole("button", { name: /log in/i });
    button.click();
    expect(onSignInClick).toHaveBeenCalledOnce();
  });

  it("renders exactly one Refresh button", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderHeader();
    await screen.findByRole("button", { name: /log in/i });
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
  });

  it("clicking Refresh with zero registered panels is a safe no-op", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderHeader();
    const button = await screen.findByRole("button", { name: "Refresh" });
    expect(() => button.click()).not.toThrow();
  });

  // Header stays mounted across a tab switch (SidePanelApp.tsx renders it outside the
  // activeTab-conditional branches), so a sign-in that happens elsewhere (AccountPage.tsx, on the
  // Settings tab) never remounts it - without registering its own session check with the refresh
  // registry, the Log-In button would keep showing until the whole panel reopens.
  it("re-checks its session (and hides Log-In) when something else calls refreshAll, without a remount", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, session: null });

    function RefreshTrigger() {
      const refreshAll = useRefreshAll();
      return (
        <button type="button" onClick={refreshAll}>
          Trigger refresh
        </button>
      );
    }

    render(
      <RefreshRegistryProvider>
        <Header onSignInClick={() => {}} />
        <RefreshTrigger />
      </RefreshRegistryProvider>
    );

    expect(await screen.findByRole("button", { name: /log in/i })).toBeInTheDocument();

    sendMessageSpy.mockResolvedValue({ ok: true, session: { user: { id: "user-1" } } });
    fireEvent.click(screen.getByRole("button", { name: "Trigger refresh" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /log in/i })).not.toBeInTheDocument()
    );
  });
});
