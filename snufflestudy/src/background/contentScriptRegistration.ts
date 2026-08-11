const CONTENT_SCRIPT_ID = "snuffles-overlay";

// Per Decision #2 in the architecture overview, the overlay content script (src/content/index.ts)
// has no static `matches` entry in its manifest declaration — it's registered dynamically here,
// only once the user has granted the "detailed" tracking tier's broad host permission, so that
// installing the extension never forces the broad-host-permission prompt up front.

export async function registerOverlayContentScript(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (existing.length > 0) return;

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      matches: ["*://*/*"],
      js: ["content-scripts/content.js"],
      runAt: "document_idle",
    },
  ]);
}

export async function unregisterOverlayContentScript(): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
}
