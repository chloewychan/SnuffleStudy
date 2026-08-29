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
import { RequestUnlockForm } from "./components/RequestUnlockForm";
import { CompletionScreen } from "../shared/ui/CompletionScreen";
import { AbandonedScreen } from "../shared/ui/AbandonedScreen";
import { useActiveSession } from "../shared/hooks/useActiveSession";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import type { UserSettings } from "../domain/settings/userSettings";
import { RefreshRegistryProvider } from "./refresh/RefreshRegistryContext";
import { StudyRoomSessionProvider } from "./studyRoom/StudyRoomSessionContext";
import { AppFooter } from "./components/AppFooter";

// v4.1 Task 2/7: RefreshRegistryProvider and StudyRoomSessionProvider both wrap the whole render
// tree here, above every tab/session branch below, so neither ever remounts on a tab switch or
// session-state change - any panel mounted in any branch can register its own refresh, and a
// joined study room survives every branch swap below (Decision 5) with the same provider
// instance. Order between the two doesn't matter - neither depends on the other.
export function SidePanelApp() {
  return (
    <RefreshRegistryProvider>
      <StudyRoomSessionProvider>
        <SidePanelAppInner />
      </StudyRoomSessionProvider>
    </RefreshRegistryProvider>
  );
}

function SidePanelAppInner() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const { session, loading } = useActiveSession();

  const [activeTab, setActiveTab] = useState<SidePanelTab>("bunny");

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
        {/* Fix 5 (final-review fix wave): TabBar.tsx's tab buttons already had role="tab"/
            aria-selected but nothing tied them to their content - each tab button's
            aria-controls="sp-tabpanel" now points at this single shared panel id (only one tab's
            content is ever mounted at a time, so one id covers all four), and aria-labelledby
            here points back at whichever tab is currently active. */}
        <div role="tabpanel" id="sp-tabpanel" aria-labelledby={`sp-tab-${activeTab}`}>
          {activeTab === "bunny" && <BunnyTab />}
          {activeTab === "study" && <StudyTab settings={settings} />}
          {activeTab === "friends" && <FriendsTab />}
          {activeTab === "settings" && <SettingsTab onSettingsChange={setSettings} />}
        </div>
        <AppFooter />
      </>
    );
  }

  if (session.state === "COMPLETED") {
    return (
      <div className="sidepanel-app">
        <CompletionScreen session={session} />
        <AppFooter />
      </div>
    );
  }

  if (session.state === "ABANDONED") {
    return (
      <div className="sidepanel-app">
        <AbandonedScreen session={session} />
        <AppFooter />
      </div>
    );
  }

  // v3.4 Task 3 (Decision 5): the requester-side "request an unlock" UI (RequestUnlockForm.tsx,
  // session-aware) used to be composed alongside a standalone approver-side "review friend
  // requests" panel (no session prop) only behind a toggle, reachable during an active session
  // since a friend might be mid-session themselves when asked to approve/deny a request.
  //
  // v4.1 Task 8: that toggle (and the standalone approver-side panel it used to reveal) is
  // removed - its content is now always visible in the new, persistent Nudges & Unlock Requests
  // footer (NudgesAndRequestsFooter.tsx, via AppFooter.tsx), not something to reveal here.
  // RequestUnlockForm is session-scoped and unaffected by this task - it renders directly
  // alongside ActiveSessionView now, instead of behind that toggle.
  return (
    <>
      <Header />
      <ActiveSessionView session={session} />
      <RequestUnlockForm session={session} />
      <AppFooter />
    </>
  );
}
