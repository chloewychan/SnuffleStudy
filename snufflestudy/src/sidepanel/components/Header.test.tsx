import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Header } from "./Header";
import { RefreshRegistryProvider } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

// v4.1 Task 2: Header now reads useRefreshAll(), which throws outside a
// RefreshRegistryProvider - every render() below needs one as an ancestor.
function renderHeader() {
  return render(
    <RefreshRegistryProvider>
      <Header />
    </RefreshRegistryProvider>
  );
}

describe("Header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: vi.fn((path: string) => `/chrome-extension://fake/${path}`),
        openOptionsPage: vi.fn(),
      },
    });
  });

  it("shows a Log-In button when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderHeader();
    expect(await screen.findByRole("button", { name: /log-in/i })).toBeInTheDocument();
  });

  it("hides the Log-In button when signed in", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: { user: { id: "user-1" } },
    });
    renderHeader();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /log-in/i })).not.toBeInTheDocument()
    );
  });

  it("opens the extension options page when Log-In is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderHeader();
    const button = await screen.findByRole("button", { name: /log-in/i });
    button.click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  it("renders exactly one Refresh button", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderHeader();
    await screen.findByRole("button", { name: /log-in/i });
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
  });

  it("clicking Refresh with zero registered panels is a safe no-op", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    renderHeader();
    const button = await screen.findByRole("button", { name: "Refresh" });
    expect(() => button.click()).not.toThrow();
  });
});
