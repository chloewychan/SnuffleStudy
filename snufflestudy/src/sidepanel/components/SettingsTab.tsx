import { AccountPage } from "../../options/pages/AccountPage";
import { HistoryPage } from "../../options/pages/HistoryPage";
import { SettingsPage } from "./settingsTab/SettingsPage";
import { ButtonLarge } from "./ui/ButtonLarge";
import type { UserSettings } from "../../domain/settings/userSettings";

interface SettingsTabProps {
  // Forwarded straight through to SettingsPage. Without this, SidePanelApp.tsx's top-level
  // `settings` state (used to start a session) would go stale the moment a change is saved here.
  onSettingsChange?: (settings: UserSettings) => void;
}

// One scrolling view of stacked boxes, matching every other tab's layout. There is no
// Settings/Account/Friends/History sub-nav here - per-friend settings live in the Friends tab
// instead. AccountPage/HistoryPage are the exact same components OptionsApp.tsx renders in its
// own "account"/"history" views - reused directly, not reimplemented.
//
// Camera & microphone access is the one deliberate exception to "everything embedded in place":
// Chrome's getUserMedia permission prompt can never be shown from the sidepanel at all (a
// documented platform limitation - see OptionsApp.tsx's own mediaGrantStatus comment), so it
// stays a full-tab-only flow. The callout button below just opens the real Options tab, which
// already has that section (still inline in OptionsApp.tsx, after its own <SettingsPage />).
export function SettingsTab({ onSettingsChange }: SettingsTabProps) {
  return (
    <div className="sp-tab-content sp-settings-tab">
      <section className="sp-card">
        <SettingsPage onSettingsSaved={onSettingsChange} />
        <div className="settings-page__section">
          {/* No "Camera & Microphone" heading here on purpose - this callout deliberately
              doesn't duplicate the real section's heading/copy, which lives once, in
              OptionsApp.tsx's still-inline version (see this file's header comment above on why
              that section can't move here). */}
          <ButtonLarge
            onClick={() => {
              // chrome.runtime.openOptionsPage() returns a Promise that can reject (e.g.
              // extension-context-invalidated), so the rejection must be caught here rather than
              // left unhandled. Promise.resolve(...) also normalizes a test mock's
              // openOptionsPage() returning undefined instead of a real Promise.
              void Promise.resolve(chrome.runtime.openOptionsPage()).catch((err) =>
                console.error("Failed to open the options page", err)
              );
            }}
          >
            Grant Camera &amp; Microphone Access
          </ButtonLarge>
        </div>
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
