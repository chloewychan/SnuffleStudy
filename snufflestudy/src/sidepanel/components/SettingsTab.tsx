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
// v4.2 Task 11: the "Grant camera & microphone access" callout that used to live here (a plain
// <button> right below <SettingsPage />) is gone - Decision 7 moved that affordance INTO
// SettingsPage.tsx itself, since that's where frontend-backup's SettingsBody.tsx design puts it
// (its own "Camera & Microphone" section, at the end of the General box). Chrome's getUserMedia
// permission prompt still can never be shown from the sidepanel at all (a documented platform
// limitation - see OptionsApp.tsx's own mediaGrantStatus header comment) - the button (now inside
// SettingsPage.tsx) still just calls chrome.runtime.openOptionsPage(), unchanged behavior, new
// location.
export function SettingsTab({ onSettingsChange }: SettingsTabProps) {
  return (
    <div className="sp-tab-content sp-settings-tab">
      <section className="sp-card">
        <SettingsPage onSettingsSaved={onSettingsChange} />
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
