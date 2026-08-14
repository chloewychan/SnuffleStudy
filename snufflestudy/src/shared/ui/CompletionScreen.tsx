import { useEffect, useState } from "react";
import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { formatOrdinal } from "./formatOrdinal";

interface CompletionScreenProps {
  session: StudySession;
}

// Shared by PopupApp and SidePanelApp. Previously a naturally-completed session was
// archived and cleared from active storage in the same instant (alarmHandlers.ts), so
// neither surface ever got a chance to render this — the UI just snapped straight back to
// idle/setup with no acknowledgment.
export function CompletionScreen({ session }: CompletionScreenProps) {
  const [completedCount, setCompletedCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Lightweight: a single SESSION_LIST_HISTORY call (Task 3) filtered by state, no new
    // persistence/counter subsystem. Best-effort - if this fails, the count line just
    // doesn't render; it isn't load-bearing for the dismiss flow below.
    sendMessage<{ ok: boolean; sessions?: StudySession[] }>({
      type: "SESSION_LIST_HISTORY",
      payload: { state: "COMPLETED" },
    })
      .then((res) => {
        if (!cancelled && res.ok && res.sessions) setCompletedCount(res.sessions.length);
      })
      .catch((err) => console.error("Failed to load completed session count", err));

    return () => {
      cancelled = true;
    };
  }, []);

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
      {completedCount !== null && (
        <p className="completion-screen__count">
          This is your {formatOrdinal(completedCount)} completed session.
        </p>
      )}
      <button onClick={handleDismiss}>Start another session</button>
    </div>
  );
}
