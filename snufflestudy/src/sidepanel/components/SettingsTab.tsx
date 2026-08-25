import { useState } from "react";
import { AccountPage } from "../../options/pages/AccountPage";
import { FriendsPage } from "../../options/pages/FriendsPage";
import { HistoryPage } from "../../options/pages/HistoryPage";
import { SettingsPage } from "./settingsTab/SettingsPage";
import type { UserSettings } from "../../domain/settings/userSettings";

type SidepanelSettingsView = "settings" | "account" | "friends" | "history";

interface SettingsTabProps {
  // QA-discovered bug (v3.3 QA pass): forwarded straight through to SettingsPage - see that
  // component's own header comment for why this exists at all (SidePanelApp.tsx's own top-level
  // `settings` state, used to start a session, would otherwise go stale the moment a change is
  // saved here).
  onSettingsChange?: (settings: UserSettings) => void;
}

// v3.3 Task 7: rebuilds the placeholder Task 1 left behind (both TempPasscodePanel and
// UnlockRequestPanel moved to FriendsTab.tsx) into a real embedded sub-nav - Settings/Account/
// Friends/History, in that order - mirroring OptionsApp.tsx's own nav-button/`view`-state pattern
// (same aria-current/disabled convention) rather than inventing a new one. AccountPage/FriendsPage/
// HistoryPage are the exact same components OptionsApp.tsx renders in its own "account"/"friends"/
// "history" views - reused directly, not reimplemented.
//
// Camera & microphone access is the one deliberate exception to "everything embedded in place":
// Chrome's getUserMedia permission prompt can never be shown from the sidepanel at all (a
// documented platform limitation - see OptionsApp.tsx's own mediaGrantStatus header comment), so
// it stays a full-tab-only flow. The callout button below just opens the real Options tab, which
// already has that section (still inline in OptionsApp.tsx, after its own <SettingsPage />).
export function SettingsTab({ onSettingsChange }: SettingsTabProps) {
  const [view, setView] = useState<SidepanelSettingsView>("settings");

  return (
    <div className="sp-tab-content sp-settings-tab">
      <nav className="sp-settings-tab__nav">
        <button
          type="button"
          aria-current={view === "settings" ? "page" : undefined}
          disabled={view === "settings"}
          onClick={() => setView("settings")}
        >
          Settings
        </button>
        <button
          type="button"
          aria-current={view === "account" ? "page" : undefined}
          disabled={view === "account"}
          onClick={() => setView("account")}
        >
          Account
        </button>
        <button
          type="button"
          aria-current={view === "friends" ? "page" : undefined}
          disabled={view === "friends"}
          onClick={() => setView("friends")}
        >
          Friends
        </button>
        <button
          type="button"
          aria-current={view === "history" ? "page" : undefined}
          disabled={view === "history"}
          onClick={() => setView("history")}
        >
          History
        </button>
      </nav>

      {view === "settings" && (
        <>
          <SettingsPage onSettingsSaved={onSettingsChange} />
          <button
            type="button"
            className="sp-settings-tab__media-callout"
            onClick={() => {
              // Standing convention in this codebase (see Header.tsx's "Fix 6" comment): never
              // leave an async call triggered from a UI handler unhandled.
              // chrome.runtime.openOptionsPage() returns a Promise that can reject (e.g.
              // extension-context-invalidated) - Promise.resolve(...) also normalizes a test
              // mock's openOptionsPage() returning undefined instead of a real Promise.
              void Promise.resolve(chrome.runtime.openOptionsPage()).catch((err) =>
                console.error("Failed to open the options page", err)
              );
            }}
          >
            Grant camera &amp; microphone access →
          </button>
        </>
      )}

      {view === "account" && <AccountPage />}

      {view === "friends" && <FriendsPage onSignInClick={() => setView("account")} />}

      {view === "history" && <HistoryPage />}
    </div>
  );
}
