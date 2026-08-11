import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // web-ext's auto-launch would open a real browser window as a side effect of `npm run dev`.
  // The sidepanel entrypoint now exists (entrypoints/sidepanel/) and side_panel.default_path
  // resolves correctly in the built manifest, so the original blocker (a manifest path
  // pointing at a nonexistent file) is gone. Auto-launch itself hasn't been re-verified in an
  // interactive browser session, so it stays disabled out of caution; verify `npm run dev` by
  // manually loading .output/chrome-mv3-dev via chrome://extensions -> "Load unpacked" instead.
  webExt: {
    disabled: true,
  },
  manifest: {
    name: "SnuffleStudy",
    description: "A consensual peer-pressure study accountability companion.",
    permissions: [
      "storage",
      "alarms",
      "notifications",
      "idle",
      "scripting",
      "declarativeNetRequest",
      "sidePanel",
    ],
    optional_host_permissions: ["*://*/*"],
    side_panel: {
      default_path: "sidepanel.html",
    },
    // A cross-origin navigation from a web page to a chrome-extension:// URL (the
    // declarativeNetRequest hard-block redirect to locked.html) and a content-script-initiated
    // fetch of an extension-bundled asset (the overlay's sprite images, requested by the host
    // page's own document, not the extension) both require Chrome to have been told the path is
    // web-accessible, or the load is blocked outright.
    web_accessible_resources: [
      {
        resources: ["locked.html", "sprites/*"],
        matches: ["<all_urls>"],
      },
    ],
  },
});
