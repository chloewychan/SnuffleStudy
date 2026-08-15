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

    // Lightweight: a single SESSION_COUNT_BY_STATE call (Task 4 fix round 2), backed by an
    // indexed count (countByState / the sessions store's "by-state" index) rather than a
    // fetch-everything-and-measure-.length call - this fires on every single session end (not
    // just when a user opens a history page), so an unbounded fetch of the full matching
    // history here would have been a hot-path cost that grows with install age. No new
    // persistence/counter subsystem. Best-effort - if this fails, the count line just doesn't
    // render; it isn't load-bearing for the dismiss flow below.
    sendMessage<{ ok: boolean; count?: number }>({
      type: "SESSION_COUNT_BY_STATE",
      payload: { state: "ABANDONED" },
    })
      .then((res) => {
        if (!cancelled && res.ok && res.count !== undefined) setAbandonedCount(res.count);
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
