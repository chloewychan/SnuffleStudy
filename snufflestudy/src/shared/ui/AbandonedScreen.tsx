import { useEffect, useState } from "react";
import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { formatOrdinal } from "./formatOrdinal";

interface AbandonedScreenProps {
  session: StudySession;
}

// Shared by PopupApp and SidePanelApp, structurally mirroring CompletionScreen.tsx's pattern
// for COMPLETED sessions. An early/manually-ended (ABANDONED) session is now also kept as the
// active session (messageRouter.ts's SESSION_END handler) instead of being cleared
// immediately, so this gets a chance to render before the UI snaps back to idle/setup.
//
// Copy is deliberately non-punitive and makes no claim about *why* the session ended (no
// "you got distracted") — consistent with the product's "consensual peer pressure, not
// guilt" tone. Ending early is acknowledged as a normal, reversible thing, not a failure.
export function AbandonedScreen({ session }: AbandonedScreenProps) {
  const [abandonedCount, setAbandonedCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Lightweight: a single SESSION_LIST_HISTORY call (Task 3) filtered by state, no new
    // persistence/counter subsystem. Best-effort - if this fails, the count line just
    // doesn't render; it isn't load-bearing for the dismiss flow below.
    sendMessage<{ ok: boolean; sessions?: StudySession[] }>({
      type: "SESSION_LIST_HISTORY",
      payload: { state: "ABANDONED" },
    })
      .then((res) => {
        if (!cancelled && res.ok && res.sessions) setAbandonedCount(res.sessions.length);
      })
      .catch((err) => console.error("Failed to load abandoned session count", err));

    return () => {
      cancelled = true;
    };
  }, []);

  function handleDismiss() {
    sendMessage({
      type: "SESSION_DISMISS_ABANDONED",
      payload: { sessionId: session.id },
    }).catch((err) => console.error("Failed to dismiss abandoned session", err));
  }

  return (
    <div className="abandoned-screen" role="status">
      <p className="abandoned-screen__headline">Session ended early</p>
      <p className="abandoned-screen__goal">{session.goal}</p>
      <p className="abandoned-screen__note">
        No pressure — pick it back up whenever you're ready.
      </p>
      {abandonedCount !== null && (
        <p className="abandoned-screen__count">
          This is your {formatOrdinal(abandonedCount)} session ended early.
        </p>
      )}
      <button onClick={handleDismiss}>Start another session</button>
    </div>
  );
}
