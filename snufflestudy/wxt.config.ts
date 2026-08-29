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
    // v4.1 Task 4 QA fix: WXT only auto-generates manifest.action from entrypoints/popup/'s
    // existence (see the deleted popup's own comment on this). With that entrypoint gone, WXT
    // emitted NO "action" key at all - not just no default_popup - and Chrome MV3 gives an
    // extension with no "action" key no toolbar button at all, so entrypoints/background.ts's
    // chrome.action.onClicked listener had nothing to ever fire from. An explicit empty action
    // block restores the toolbar icon (using the manifest's own top-level "icons") with no popup,
    // which is what actually makes onClicked reachable.
    action: {},
    // QA-discovered (v3.2 Task 9): options.html needs open_in_tab: true (Chrome's embedded
    // chrome://extensions/?options=<id> view silently blocks window.confirm()/alert()/prompt()
    // and getUserMedia() - see AccountPage.tsx's/mediaPermissions.ts's own comments). WXT
    // auto-generates manifest.options_ui from the options entrypoint itself and that overrides
    // whatever's set here, so the actual setting lives in
    // entrypoints/options/index.html's <meta name="manifest.open_in_tab"> tag instead - this
    // comment exists so the setting doesn't look silently unconfigured from this file alone.
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
