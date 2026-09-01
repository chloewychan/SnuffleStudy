import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { ButtonLarge } from "../../sidepanel/components/ui/ButtonLarge";

interface PauseResumeControlProps {
  session: StudySession;
}

// design-specs/frames/page-study-session.json's button-options. Only ActiveSessionView.tsx
// mounts this now (the standalone browser-action popup entrypoint this comment used to also
// mention was removed from the manifest before this task).
export function PauseResumeControl({ session }: PauseResumeControlProps) {
  if (session.state === "FOCUSING") {
    return (
      <ButtonLarge
        onClick={() =>
          sendMessage({ type: "SESSION_PAUSE", payload: { sessionId: session.id } }).catch((err) =>
            console.error("Failed to pause session", err)
          )
        }
      >
        Pause
      </ButtonLarge>
    );
  }

  if (session.state === "PAUSED") {
    return (
      <ButtonLarge
        onClick={() =>
          sendMessage({ type: "SESSION_RESUME", payload: { sessionId: session.id } }).catch((err) =>
            console.error("Failed to resume session", err)
          )
        }
      >
        Resume
      </ButtonLarge>
    );
  }

  return null;
}
