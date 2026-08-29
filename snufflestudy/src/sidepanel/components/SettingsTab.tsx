import { AccountPage } from "../../options/pages/AccountPage";
import { HistoryPage } from "../../options/pages/HistoryPage";
import { SettingsPage } from "./settingsTab/SettingsPage";
import type { UserSettings } from "../../domain/settings/userSettings";

interface SettingsTabProps {
  // QA-discovered bug (v3.3 QA pass): forwarded straight through to SettingsPage - see that
  // component's own header comment for why this exists at all (SidePanelApp.tsx's own top-level
  // `settings` state, used to start a session, would otherwise go stale the moment a change is
  // saved here).
  onSettingsChange?: (settings: UserSettings) => void;
}

// v4.1 Task 10: replaces the v3.3-era Settings/Account/Friends/History sub-nav with one scrolling
// view of stacked boxes, matching every other tab's layout (scope doc's Settings section). The
// Friends destination is dropped entirely - its content now lives in the sidebar's own Friends tab
// (FriendsBox.tsx's per-friend options popover, Task 9), not anywhere in Settings. AccountPage/
// HistoryPage are the exact same components OptionsApp.tsx renders in its own "account"/"history"
// views - reused directly, not reimplemented.
//
// Camera & microphone access is the one deliberate exception to "everything embedded in place":
// Chrome's getUserMedia permission prompt can never be shown from the sidepanel at all (a
// documented platform limitation - see OptionsApp.tsx's own mediaGrantStatus header comment), so
// it stays a full-tab-only flow. The callout button below just opens the real Options tab, which
// already has that section (still inline in OptionsApp.tsx, after its own <SettingsPage />).
export function SettingsTab({ onSettingsChange }: SettingsTabProps) {
  return (
    <div className="sp-tab-content sp-settings-tab">
      <section className="sp-card">
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
      </section>

      <section className="sp-card">
        <AccountPage />
      </section>

      <section className="sp-card">
        <HistoryPage />
      </section>
    </div>
  );
}
