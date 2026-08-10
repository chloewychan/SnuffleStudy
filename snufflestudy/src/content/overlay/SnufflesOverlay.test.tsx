import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SnufflesOverlay } from "./SnufflesOverlay";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SnufflesOverlay", () => {
  it("shows only the idle companion when the site is allowed", () => {
    render(
      <SnufflesOverlay
        classification="ALLOWED"
        sessionId="session_1"
        hostname="docs.google.com"
        reducedMotion={false}
      />
    );
    expect(screen.queryByText("That is not chemistry.")).not.toBeInTheDocument();
  });

  it("shows a warning with actions when the site is blocked", () => {
    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );
    expect(screen.getByText("That is not chemistry.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to work" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark this site as study-related" })).toBeInTheDocument();
  });

  it("sends MARK_SITE_STUDY_RELATED and dismisses the warning when clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark this site as study-related" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "MARK_SITE_STUDY_RELATED",
        payload: { sessionId: "session_1", hostname: "youtube.com" },
      })
    );
    expect(screen.queryByText("That is not chemistry.")).not.toBeInTheDocument();
  });

  it("uses the staticFrame image when reducedMotion is true", () => {
    render(
      <SnufflesOverlay classification="ALLOWED" sessionId="session_1" hostname="docs.google.com" reducedMotion />
    );
    // Resolved via chrome.runtime.getURL (see animationRegistry.ts), not a root-absolute literal
    // - a plain "/sprites/..." string would resolve against the host page's origin inside a real
    // content script, not the extension's. wxt/testing/fake-browser's chrome.runtime.getURL
    // resolves to chrome-extension://test-extension-id/<path>.
    expect(screen.getByAltText("Snuffles")).toHaveAttribute(
      "src",
      chrome.runtime.getURL("sprites/placeholder-focused.png")
    );
  });
});
