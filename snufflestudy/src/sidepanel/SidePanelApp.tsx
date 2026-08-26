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
import { FriendRequestPanel } from "./components/FriendRequestPanel";
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
  // v3.4 Task 3: replaces the two separate showUnlockPanel/showTempPasscodePanel booleans
  // (v2 Task 8/Task 12) with one - unlock_requests/temp_passcode_requests/session_end_requests
  // are now one friend_requests table behind one FriendRequestPanel.tsx, so there's only one
  // panel to show/hide. Separate from `activeTab` above - `activeTab` only governs the
  // no-active-session branch's tab routing (bunny/study/friends/settings), while a running
  // session has its own dedicated render branch further below that doesn't go through
  // `activeTab` at all.
  const [showFriendRequestPanel, setShowFriendRequestPanel] = useState(false);

  // A fresh session should never inherit a panel left open from a previous one.
  useEffect(() => {
    if (session) {
      setShowFriendRequestPanel(false);
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

  // v3.4 Task 3 (Decision 5): the requester-side "request an unlock" UI (RequestUnlockForm.tsx,
  // session-aware) and the approver-side "review friend requests" UI (FriendRequestPanel.tsx, no
  // session prop) are composed side by side here - reachable during an active session too, not
  // just the no-session tab routing above, since a friend might be mid-session themselves when
  // asked to approve/deny a request. Replaces this view's normal contents rather than overlaying
  // them, same pattern as the COMPLETED/ABANDONED branches above swapping in a different screen
  // entirely (unchanged from the pre-Task-3 showUnlockPanel/showTempPasscodePanel branches this
  // one collapses into).
  if (showFriendRequestPanel) {
    return (
      <>
        <Header />
        <RequestUnlockForm session={session} />
        <FriendRequestPanel onClose={() => setShowFriendRequestPanel(false)} />
      </>
    );
  }

  return (
    <>
      <Header />
      <ActiveSessionView
        session={session}
        onShowFriendRequestPanel={() => setShowFriendRequestPanel(true)}
      />
    </>
  );
}
