import { onMessage } from "../src/infrastructure/messaging/extensionMessenger";
import { handleMessage } from "../src/background/messageRouter";
import { registerAlarmHandlers } from "../src/background/alarmHandlers";
import { registerTabHandlers } from "../src/background/tabHandlers";
import { registerIdleHandlers } from "../src/background/idleHandlers";

export default defineBackground(() => {
  onMessage(handleMessage);
  registerAlarmHandlers();
  registerTabHandlers();
  registerIdleHandlers();
});
