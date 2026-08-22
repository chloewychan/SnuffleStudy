import { useEffect, useState } from "react";
import "../styles/global.css";
import "../styles/sidepanel.css";
import { OnboardingWizard } from "../app/routes/OnboardingWizard";
import { TabBar, type SidePanelTab } from "./components/TabBar";
import { Header } from "./components/Header";
import { BunnyTab } from "./components/BunnyTab";
import { StudyTab } from "./components/StudyTab";
import { FriendsTab } from "./components/FriendsTab";
import { SettingsTab } from "./components/SettingsTab";
import { ActiveSessionView } from "./components/ActiveSessionView";
import { UnlockRequestPanel } from "./components/UnlockRequestPanel";
import { TempPasscodePanel } from "./components/TempPasscodePanel";
import { CompletionScreen } from "../shared/ui/CompletionScreen";
import { AbandonedScreen } from "../shared/ui/AbandonedScreen";
import { useActiveSession } from "../popup/hooks/useActiveSession";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import type { UserSettings } from "../domain/settings/userSettings";

export function SidePanelApp() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const { session, loading } = useActiveSession();

  const [activeTab, setActiveTab] = useState<SidePanelTab>("bunny");
  // v2 Task 8: whether the active-session view has UnlockRequestPanel overlaid below its normal
  // ActiveSessionView contents. Separate from `activeTab` above - `activeTab` only governs the
  // no-active-session branch's tab routing (bunny/study/friends/settings), while a running
  // session has its own dedicated render branch further below that doesn't go through
  // `activeTab` at all.
  const [showUnlockPanel, setShowUnlockPanel] = useState(false);
  // v2 Task 12: same treatment as showUnlockPanel above, for TempPasscodePanel - reachable from
  // the active-session view too, not just the no-session tab routing below, since a friend
  // might be mid-session themselves when asked to approve/deny a temp-passcode request.
  const [showTempPasscodePanel, setShowTempPasscodePanel] = useState(false);

  // A fresh session should never inherit a panel left open from a previous one.
  useEffect(() => {
    if (session) {
      setShowUnlockPanel(false);
      setShowTempPasscodePanel(false);
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
    return (
      <>
        <Header />
        <TabBar active={activeTab} onSelect={setActiveTab} />
        {activeTab === "bunny" && <BunnyTab />}
        {activeTab === "study" && <StudyTab settings={settings} />}
        {activeTab === "friends" && <FriendsTab />}
        {activeTab === "settings" && <SettingsTab />}
      </>
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

  return (
    <>
      <Header />
      <ActiveSessionView
        session={session}
        onShowUnlockPanel={() => setShowUnlockPanel(true)}
        onShowTempPasscodePanel={() => setShowTempPasscodePanel(true)}
      />
      {showUnlockPanel && (
        <UnlockRequestPanel session={session} onClose={() => setShowUnlockPanel(false)} />
      )}
      {showTempPasscodePanel && (
        <TempPasscodePanel onClose={() => setShowTempPasscodePanel(false)} />
      )}
    </>
  );
}
