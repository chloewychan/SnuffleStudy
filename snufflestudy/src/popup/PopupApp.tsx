import "../styles/global.css";
import { useActiveSession } from "./hooks/useActiveSession";
import { TimerRing } from "../shared/ui/TimerRing";
import { SessionStatusCard } from "../shared/ui/SessionStatusCard";
import { EndSessionControl } from "../shared/ui/EndSessionControl";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import { remainingSeconds } from "../domain/session/timer";

async function openSidePanel() {
  // chrome.sidePanel.open() requires a tabId or windowId — {} is rejected both
  // by the type checker and at runtime ("Either windowId or tabId must be specified").
  const win = await chrome.windows.getCurrent();
  if (win.id !== undefined) {
    await chrome.sidePanel?.open({ windowId: win.id });
  }
}

export function PopupApp() {
  const { session, loading } = useActiveSession();

  if (loading) return <div className="popup-app">Loading…</div>;

  if (!session) {
    return (
      <div className="popup-app popup-app--idle">
        <p>No active session.</p>
        <button onClick={() => void openSidePanel()}>Start a session</button>
      </div>
    );
  }

  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="popup-app">
      <SessionStatusCard session={session} />
      <TimerRing remainingSeconds={remainingSeconds(session, Date.now())} totalSeconds={totalSeconds} />
      <div className="popup-app__controls">
        {session.state === "FOCUSING" && (
          <button
            onClick={() =>
              sendMessage({ type: "SESSION_PAUSE", payload: { sessionId: session.id } }).catch((err) =>
                console.error("Failed to pause session", err)
              )
            }
          >
            Pause
          </button>
        )}
        {session.state === "PAUSED" && (
          <button
            onClick={() =>
              sendMessage({ type: "SESSION_RESUME", payload: { sessionId: session.id } }).catch((err) =>
                console.error("Failed to resume session", err)
              )
            }
          >
            Resume
          </button>
        )}
        <EndSessionControl session={session} />
      </div>
    </div>
  );
}
