import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WelcomeScreen } from "./WelcomeScreen";
import { RefreshRegistryProvider } from "../../sidepanel/refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

// design-specs/frames/page-welcome.json: WelcomeScreen now renders the real Header (header-bar),
// so it needs the same RefreshRegistryProvider/chrome.runtime.getURL/AUTH_GET_SESSION scaffolding
// Header.test.tsx itself uses.
function renderWelcome(onContinue: () => void = () => {}) {
  return render(
    <RefreshRegistryProvider>
      <WelcomeScreen onContinue={onContinue} />
    </RefreshRegistryProvider>
  );
}

describe("WelcomeScreen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: vi.fn((path: string) => `/chrome-extension://fake/${path}`),
      },
    });
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
  });

  it("explains the product's purpose as consensual peer pressure, not a generic timer", () => {
    renderWelcome();

    expect(screen.getByText(/consensual peer pressure/i)).toBeInTheDocument();
    expect(screen.getByText(/isn't a generic focus timer/i)).toBeInTheDocument();
  });

  it("calls onContinue when the user dismisses the screen", () => {
    const onContinue = vi.fn();
    renderWelcome(onContinue);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onContinue).toHaveBeenCalled();
  });

  it("calls onContinue when Log In is clicked in the header, same as Continue", async () => {
    const onContinue = vi.fn();
    renderWelcome(onContinue);

    const loginButton = await screen.findByRole("button", { name: "Log In" });
    fireEvent.click(loginButton);

    expect(onContinue).toHaveBeenCalled();
  });
});
