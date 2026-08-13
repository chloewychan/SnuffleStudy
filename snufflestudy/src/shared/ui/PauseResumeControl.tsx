import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

interface PauseResumeControlProps {
  session: StudySession;
}

// Shared by PopupApp and SidePanelApp (mirrors the existing EndSessionControl extraction
// precedent) — previously only PopupApp had these buttons at all.
export function PauseResumeControl({ session }: PauseResumeControlProps) {
  if (session.state === "FOCUSING") {
    return (
      <button
        onClick={() =>
          sendMessage({ type: "SESSION_PAUSE", payload: { sessionId: session.id } }).catch((err) =>
            console.error("Failed to pause session", err)
          )
        }
      >
        Pause
      </button>
    );
  }

  if (session.state === "PAUSED") {
    return (
      <button
        onClick={() =>
          sendMessage({ type: "SESSION_RESUME", payload: { sessionId: session.id } }).catch((err) =>
            console.error("Failed to resume session", err)
          )
        }
      >
        Resume
      </button>
    );
  }

  return null;
}
