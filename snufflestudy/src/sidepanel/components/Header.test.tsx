import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Header } from "./Header";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

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
    render(<Header />);
    expect(await screen.findByRole("button", { name: /log-in/i })).toBeInTheDocument();
  });

  it("hides the Log-In button when signed in", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: { user: { id: "user-1" } },
    });
    render(<Header />);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /log-in/i })).not.toBeInTheDocument()
    );
  });

  it("opens the extension options page when Log-In is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    render(<Header />);
    const button = await screen.findByRole("button", { name: /log-in/i });
    button.click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });
});
