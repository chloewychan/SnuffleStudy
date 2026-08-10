import { useEffect, useState } from "react";
import { OnboardingWizard } from "../app/routes/OnboardingWizard";
import { SessionSetupForm } from "./components/SessionSetupForm";
import { SessionStatusCard } from "../shared/ui/SessionStatusCard";
import { TimerRing } from "../shared/ui/TimerRing";
import { useActiveSession } from "../popup/hooks/useActiveSession";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import { remainingSeconds } from "../domain/session/timer";
import type { UserSettings } from "../domain/settings/userSettings";

export function SidePanelApp() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const { session, loading } = useActiveSession();

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
    return (
      <div className="sidepanel-app">
        <SessionSetupForm settings={settings} />
      </div>
    );
  }

  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="sidepanel-app">
      <SessionStatusCard session={session} />
      <TimerRing remainingSeconds={remainingSeconds(session, Date.now())} totalSeconds={totalSeconds} />
      <ul className="sidepanel-app__sites">
        {session.restrictedSites.map((site) => (
          <li key={site}>{site}</li>
        ))}
      </ul>
      <button
        onClick={() =>
          sendMessage({ type: "SESSION_END", payload: { sessionId: session.id } }).catch((err) =>
            console.error("Failed to end session", err)
          )
        }
      >
        End session
      </button>
    </div>
  );
}
