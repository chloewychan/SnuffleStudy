import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // web-ext's auto-launch validates that manifest paths (e.g. side_panel.default_path)
  // exist on disk. The sidepanel entrypoint isn't created until a later task, so auto-launch
  // is disabled here; verify `npm run dev` by manually loading .output/chrome-mv3-dev via
  // chrome://extensions -> "Load unpacked" instead.
  webExt: {
    disabled: true,
  },
  manifest: {
    name: "SnuffleStudy",
    description: "A consensual peer-pressure study accountability companion.",
    permissions: ["storage", "alarms", "notifications", "idle", "scripting", "declarativeNetRequest"],
    optional_host_permissions: ["*://*/*"],
    side_panel: {
      default_path: "sidepanel.html",
    },
  },
});
