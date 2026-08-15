import { useEffect, useState } from "react";
import "../styles/global.css";
import { OnboardingWizard } from "../app/routes/OnboardingWizard";
import { TaskVaultPage } from "../app/routes/TaskVaultPage";
import { SessionSetupForm } from "./components/SessionSetupForm";
import { FriendGroupPanel } from "./components/FriendGroupPanel";
import { UnlockRequestPanel } from "./components/UnlockRequestPanel";
import { SessionStatusCard } from "../shared/ui/SessionStatusCard";
import { TimerRing } from "../shared/ui/TimerRing";
import { EndSessionControl } from "../shared/ui/EndSessionControl";
import { PauseResumeControl } from "../shared/ui/PauseResumeControl";
import { CompletionScreen } from "../shared/ui/CompletionScreen";
import { AbandonedScreen } from "../shared/ui/AbandonedScreen";
import { useActiveSession } from "../popup/hooks/useActiveSession";
import { useNow } from "../popup/hooks/useNow";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import { remainingSeconds } from "../domain/session/timer";
import type { UserSettings } from "../domain/settings/userSettings";

type SidePanelView = "setup" | "taskVault" | "friends" | "unlockRequests";

export function SidePanelApp() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const { session, loading } = useActiveSession();
  const now = useNow();

  const [view, setView] = useState<SidePanelView>("setup");
  const [sessionPrefill, setSessionPrefill] = useState<{
    goal?: string;
    taskBreakdownItemId?: string;
  }>({});
  // v2 Task 8: whether the active-session view is showing UnlockRequestPanel instead of its
  // normal timer/controls. Separate from `view` above - `view` only governs the no-active-session
  // branch's routing (setup/taskVault/friends/unlockRequests), while a running session has its
  // own dedicated render branch further below that doesn't go through `view` at all.
  const [showUnlockPanel, setShowUnlockPanel] = useState(false);

  // Once a session actually starts, drop back to a clean "setup" view/no-prefill state for
  // next time - otherwise a stale goal/taskBreakdownItemId from a Task Vault pick would
  // silently resurface in SessionSetupForm the next time this session ends (SessionSetupForm
  // only reads initialGoal on mount, and this component doesn't unmount between sessions).
  useEffect(() => {
    if (session) {
      setView("setup");
      setSessionPrefill({});
      // A fresh session should never inherit a panel left open from a previous one.
      setShowUnlockPanel(false);
    }
  }, [session]);

  useEffect(() => {
    let cancelled = false;

    sendMessage<{ ok: boolean; settings: UserSettings }>({ type: "SETTINGS_GET" })
      .then((res) => {
        if (!cancelled) {
          setSettings(res.settings);
          setSettingsError(null);
        }
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated. The whole app is gated behind this call
        // succeeding, so surface the failure instead of leaving the app stuck on
        // "Loading…" forever with no signal.
        console.error("Failed to load settings", err);
        if (!cancelled) {
          setSettingsError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (settingsError) {
    return (
      <div className="sidepanel-app">
        <p role="alert">Couldn't load your settings: {settingsError}. Please reopen the side panel.</p>
      </div>
    );
  }

  if (loading || !settings) return <div className="sidepanel-app">Loading…</div>;

  if (!settings.onboardingCompleted) {
    return (
      <div className="sidepanel-app">
        <OnboardingWizard
          onComplete={() =>
            sendMessage<{ ok: boolean; settings: UserSettings }>({ type: "SETTINGS_GET" })
              .then((res) => setSettings(res.settings))
              .catch((err) => console.error("Failed to refresh settings after onboarding", err))
          }
        />
      </div>
    );
  }

  if (!session) {
    if (view === "taskVault") {
      return (
        <div className="sidepanel-app">
          <TaskVaultPage
            onClose={() => setView("setup")}
            onStartSessionFromBreakdownItem={({ goal, taskBreakdownItemId }) => {
              setSessionPrefill({ goal, taskBreakdownItemId });
              setView("setup");
            }}
          />
        </div>
      );
    }

    if (view === "friends") {
      return (
        <div className="sidepanel-app">
          <FriendGroupPanel onClose={() => setView("setup")} />
        </div>
      );
    }

    if (view === "unlockRequests") {
      return (
        <div className="sidepanel-app">
          <UnlockRequestPanel session={null} onClose={() => setView("setup")} />
        </div>
      );
    }

    return (
      <div className="sidepanel-app">
        <button type="button" onClick={() => setView("taskVault")}>
          Task Vault
        </button>
        <button type="button" onClick={() => setView("friends")}>
          Friend activity
        </button>
        <button type="button" onClick={() => setView("unlockRequests")}>
          Unlock requests
        </button>
        <SessionSetupForm
          settings={settings}
          initialGoal={sessionPrefill.goal}
          taskBreakdownItemId={sessionPrefill.taskBreakdownItemId}
        />
      </div>
    );
  }

  if (session.state === "COMPLETED") {
    return (
      <div className="sidepanel-app">
        <CompletionScreen session={session} />
      </div>
    );
  }

  if (session.state === "ABANDONED") {
    return (
      <div className="sidepanel-app">
        <AbandonedScreen session={session} />
      </div>
    );
  }

  // v2 Task 8: the requester-side "request an unlock for a hostname" UI only makes sense while
  // a session is actually running - reachable from a button in this active-session view (unlike
  // FriendGroupPanel, which is only reachable from the no-session setup view above). Replaces
  // this view's normal contents rather than overlaying them, same pattern as the
  // COMPLETED/ABANDONED branches above swapping in a different screen entirely.
  if (showUnlockPanel) {
    return (
      <div className="sidepanel-app">
        <UnlockRequestPanel session={session} onClose={() => setShowUnlockPanel(false)} />
      </div>
    );
  }

  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="sidepanel-app">
      <SessionStatusCard session={session} />
      <TimerRing remainingSeconds={remainingSeconds(session, now)} totalSeconds={totalSeconds} />
      <ul className="sidepanel-app__sites">
        {session.restrictedSites.map((site) => (
          <li key={site}>{site}</li>
        ))}
      </ul>
      <div className="sidepanel-app__controls">
        <PauseResumeControl session={session} />
        <EndSessionControl session={session} />
        <button type="button" onClick={() => setShowUnlockPanel(true)}>
          Unlock requests
        </button>
      </div>
    </div>
  );
}
