import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

interface CompletionScreenProps {
  session: StudySession;
}

// Shared by PopupApp and SidePanelApp. Previously a naturally-completed session was
// archived and cleared from active storage in the same instant (alarmHandlers.ts), so
// neither surface ever got a chance to render this — the UI just snapped straight back to
// idle/setup with no acknowledgment.
export function CompletionScreen({ session }: CompletionScreenProps) {
  function handleDismiss() {
    sendMessage({
      type: "SESSION_DISMISS_COMPLETED",
      payload: { sessionId: session.id },
    }).catch((err) => console.error("Failed to dismiss completed session", err));
  }

  return (
    <div className="completion-screen" role="status">
      <p className="completion-screen__headline">Goal complete!</p>
      <p className="completion-screen__goal">{session.goal}</p>
      <button onClick={handleDismiss}>Start another session</button>
    </div>
  );
}
