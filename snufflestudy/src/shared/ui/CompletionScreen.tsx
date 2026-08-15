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

    // Lightweight: a single SESSION_COUNT_BY_STATE call (Task 4 fix round 2), backed by an
    // indexed count (countByState / the sessions store's "by-state" index) rather than a
    // fetch-everything-and-measure-.length call - this fires on every single session end (not
    // just when a user opens a history page), so an unbounded fetch of the full matching
    // history here would have been a hot-path cost that grows with install age. No new
    // persistence/counter subsystem. Best-effort - if this fails, the count line just doesn't
    // render; it isn't load-bearing for the dismiss flow below.
    sendMessage<{ ok: boolean; count?: number }>({
      type: "SESSION_COUNT_BY_STATE",
      payload: { state: "COMPLETED" },
    })
      .then((res) => {
        if (!cancelled && res.ok && res.count !== undefined) setCompletedCount(res.count);
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
