import { onMessage } from "../src/infrastructure/messaging/extensionMessenger";
import { handleMessage } from "../src/background/messageRouter";
import { registerAlarmHandlers } from "../src/background/alarmHandlers";
import { registerTabHandlers } from "../src/background/tabHandlers";
import { registerIdleHandlers } from "../src/background/idleHandlers";
import { registerActivityTrackingHandlers } from "../src/background/activityTrackingHandlers";

export default defineBackground(() => {
  onMessage(handleMessage);
  registerAlarmHandlers();
  registerTabHandlers();
  registerIdleHandlers();
  registerActivityTrackingHandlers();
  // v4.1 Task 4 QA fix: chrome.sidePanel.open() must be called synchronously, in direct response
  // to the user gesture that triggered onClicked - Chrome only associates a gesture with an API
  // call made before any `await` yields control back to the event loop. The original version
  // (mirrored from the old, now-deleted PopupApp's own openSidePanel()) awaited
  // chrome.windows.getCurrent() first, which inserts exactly that async gap and produced "Error:
  // sidePanel.open() may only be called in response to a user gesture." onClicked's own `tab`
  // parameter already carries windowId synchronously (always present - chrome.tabs.Tab.windowId
  // is non-optional), so no lookup, and no await before the call, is needed at all.
  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  });
});
