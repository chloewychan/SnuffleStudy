import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { stubFakeScripting } from "./testSupport/fakeScripting";
import { registerOverlayContentScript, unregisterOverlayContentScript } from "./contentScriptRegistration";

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeScripting();
});

describe("registerOverlayContentScript", () => {
  it("registers the overlay content script under a stable id", async () => {
    await registerOverlayContentScript();

    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: ["snuffles-overlay"],
    });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      id: "snuffles-overlay",
      matches: ["*://*/*"],
      js: ["content-scripts/content.js"],
      runAt: "document_idle",
    });
  });

  it("is idempotent — does not double-register if already registered", async () => {
    await registerOverlayContentScript();
    await registerOverlayContentScript();

    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: ["snuffles-overlay"],
    });
    expect(registered).toHaveLength(1);
  });
});

describe("unregisterOverlayContentScript", () => {
  it("removes a previously registered overlay content script", async () => {
    await registerOverlayContentScript();
    await unregisterOverlayContentScript();

    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: ["snuffles-overlay"],
    });
    expect(registered).toHaveLength(0);
  });

  it("is a no-op when nothing is registered", async () => {
    await expect(unregisterOverlayContentScript()).resolves.toBeUndefined();
  });
});
