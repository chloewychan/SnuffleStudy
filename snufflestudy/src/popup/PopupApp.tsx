import "../styles/global.css";
import { useActiveSession } from "./hooks/useActiveSession";
import { useNow } from "./hooks/useNow";
import { TimerRing } from "../shared/ui/TimerRing";
import { SessionStatusCard } from "../shared/ui/SessionStatusCard";
import { EndSessionControl } from "../shared/ui/EndSessionControl";
import { PauseResumeControl } from "../shared/ui/PauseResumeControl";
import { CompletionScreen } from "../shared/ui/CompletionScreen";
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
  const now = useNow();

  if (loading) return <div className="popup-app">Loading…</div>;

  if (!session) {
    return (
      <div className="popup-app popup-app--idle">
        <p>No active session.</p>
        <button onClick={() => void openSidePanel()}>Start a session</button>
      </div>
    );
  }

  if (session.state === "COMPLETED") {
    return (
      <div className="popup-app">
        <CompletionScreen session={session} />
      </div>
    );
  }

  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="popup-app">
      <SessionStatusCard session={session} />
      <TimerRing remainingSeconds={remainingSeconds(session, now)} totalSeconds={totalSeconds} />
      <div className="popup-app__controls">
        <PauseResumeControl session={session} />
        <EndSessionControl session={session} />
      </div>
    </div>
  );
}
