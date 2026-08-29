import { onMessage } from "../src/infrastructure/messaging/extensionMessenger";
import { handleMessage } from "../src/background/messageRouter";
import { registerAlarmHandlers } from "../src/background/alarmHandlers";
import { registerTabHandlers } from "../src/background/tabHandlers";
import { registerIdleHandlers } from "../src/background/idleHandlers";
import { registerActivityTrackingHandlers } from "../src/background/activityTrackingHandlers";

// v4.1 Task 4: with the popup entrypoint removed, the manifest has no action.default_popup, so
// Chrome's default toolbar-icon behavior is to fire chrome.action.onClick instead of opening a
// popup. This mirrors the old PopupApp's own openSidePanel() exactly (now deleted): get the
// current window, then open the side panel for it, guarding the case where the window has no id.
async function openSidePanel() {
  const win = await chrome.windows.getCurrent();
  if (win.id !== undefined) {
    await chrome.sidePanel?.open({ windowId: win.id });
  }
}

export default defineBackground(() => {
  onMessage(handleMessage);
  registerAlarmHandlers();
  registerTabHandlers();
  registerIdleHandlers();
  registerActivityTrackingHandlers();
  chrome.action.onClicked.addListener(() => {
    openSidePanel().catch(console.error);
  });
});
