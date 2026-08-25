import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { UserSettings, TrackingTier } from "../../../domain/settings/userSettings";
import { sendMessage } from "../../../infrastructure/messaging/extensionMessenger";
import {
  requestDetailedTrackingPermission,
  revokeDetailedTrackingPermission,
} from "../../../infrastructure/browser/permissionsApi";
import {
  registerOverlayContentScript,
  unregisterOverlayContentScript,
} from "../../../background/contentScriptRegistration";

// v3.3 Task 7: extracted verbatim from OptionsApp.tsx's inline "settings" view - same state
// (settings, trackingChanging, passcode/oldPasscode/etc.), same handlers (updateSettings,
// handleTrackingTierChange, handleSavePasscode), same messages (SETTINGS_GET/SETTINGS_SAVE/
// HARD_BLOCK_SET_PASSCODE) - minus the "Camera & microphone access" section, which stays inline in
// OptionsApp.tsx only: Chrome's getUserMedia permission prompt can't be shown from the sidepanel at
// all (a documented platform limitation - see OptionsApp.tsx's own mediaGrantStatus header
// comment), so that section is a full-tab-only affordance. This component is composed by both
// OptionsApp.tsx (full tab, followed by the still-inline camera/microphone section) and the
// sidepanel's SettingsTab.tsx (Task 7's new Settings/Account/Friends/History sub-nav) - one shared
// source for the Tracking/Friends/Notifications/Default-restricted-sites/Hard-block-passcode UI.
//
// QA-discovered bug (v3.3 QA pass): this component owns its OWN settings state, fetched
// independently of SidePanelApp.tsx's own top-level `settings` (passed down to StudyTab ->
// SessionSetupForm, which is what a new session actually gets created with). Saving a change here
// persists it correctly in the background, but never told SidePanelApp's own copy to refresh -
// starting a session right after editing something here (e.g. a restricted site), with no reload
// in between, silently used whatever SidePanelApp had fetched once on mount. `onSettingsSaved` is
// optional specifically so OptionsApp.tsx's own standalone full-tab usage (no sibling state to
// keep in sync there) is unaffected - only SettingsTab.tsx (the sidepanel) passes one through.
export function SettingsPage({
  onSettingsSaved,
}: {
  onSettingsSaved?: (settings: UserSettings) => void;
} = {}): JSX.Element {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [trackingChanging, setTrackingChanging] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [oldPasscode, setOldPasscode] = useState("");
  const [passcodeSaved, setPasscodeSaved] = useState(false);
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [passcodeSaving, setPasscodeSaving] = useState(false);

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
        // or extension-context-invalidated. This view is gated behind this call succeeding, so
        // surface the failure instead of leaving it stuck on "Loading…" forever with no signal.
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
      <div className="settings-page">
        <p role="alert">Couldn't load your settings: {settingsError}. Please reload this page.</p>
      </div>
    );
  }

  if (!settings) return <div className="settings-page">Loading…</div>;

  async function updateSettings(patch: Partial<UserSettings>) {
    const previous = settings!;
    const next = { ...previous, ...patch };
    // Optimistic update: reflect the change immediately for a responsive UI, but if the
    // save below fails, roll back to what's actually persisted. Without this, a failed
    // save would leave the UI showing a change that silently never made it to storage.
    setSettings(next);
    setSaveError(null);
    try {
      await sendMessage({ type: "SETTINGS_SAVE", payload: next });
      onSettingsSaved?.(next);
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated.
      console.error("Failed to save settings", err);
      setSettings(previous);
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleTrackingTierChange(tier: TrackingTier) {
    setTrackingChanging(true);
    setSaveError(null);
    try {
      if (tier === "detailed") {
        const granted = await requestDetailedTrackingPermission();
        if (!granted) return;
        try {
          await registerOverlayContentScript();
        } catch (err) {
          // Registering the dynamic overlay content script (chrome.scripting.
          // registerContentScripts) is best-effort: the permission grant and tier switch
          // below are the part the user actually asked for and should still go through even
          // if this fails. A failure here just means the Snuffles overlay won't appear until
          // it's retried (e.g. toggling the tier again) — not worth rolling back the whole
          // change or blocking the save over, so it's logged rather than surfaced as
          // `saveError`.
          console.error("Failed to register overlay content script", err);
        }
      } else {
        await revokeDetailedTrackingPermission();
        try {
          await unregisterOverlayContentScript();
        } catch (err) {
          // Same best-effort rationale as registerOverlayContentScript above.
          console.error("Failed to unregister overlay content script", err);
        }
      }
      await updateSettings({ trackingTier: tier });
    } catch (err) {
      // requestDetailedTrackingPermission / revokeDetailedTrackingPermission
      // (chrome.permissions.request/remove) can reject — e.g. extension-context-invalidated.
      console.error("Failed to change tracking tier", err);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrackingChanging(false);
    }
  }

  async function handleSavePasscode() {
    setPasscodeSaving(true);
    setPasscodeError(null);
    try {
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: "HARD_BLOCK_SET_PASSCODE",
        payload: { passcode, oldPasscode: oldPasscode || undefined },
      });
      if (!response.ok) {
        // The backend distinguishes "no credential yet" from "wrong/missing current passcode"
        // via this error message - the frontend has no cheap way to know in advance whether a
        // credential already exists without a separate round-trip, so it always renders the
        // old-passcode field and lets the backend's response drive the error state.
        setPasscodeError(response.error ?? "Couldn't save your passcode.");
        return;
      }
      setPasscode("");
      setOldPasscode("");
      setPasscodeSaved(true);
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated. Surface it so the user isn't left unsure whether
      // their hard-block passcode actually saved.
      console.error("Failed to save hard-block passcode", err);
      setPasscodeError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasscodeSaving(false);
    }
  }

  return (
    <div className="settings-page">
      <section>
        <h2>Tracking</h2>
        <label>
          <input
            type="radio"
            checked={settings.trackingTier === "activity-only"}
            onChange={() => handleTrackingTierChange("activity-only")}
            disabled={trackingChanging}
          />
          Activity-only
        </label>
        <label>
          <input
            type="radio"
            checked={settings.trackingTier === "detailed"}
            onChange={() => handleTrackingTierChange("detailed")}
            disabled={trackingChanging}
          />
          Detailed site tracking
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.activityTrackingEnabled}
            disabled={settings.trackingTier !== "activity-only"}
            onChange={(e) => updateSettings({ activityTrackingEnabled: e.target.checked })}
          />
          Track idle/active status during focus sessions
        </label>
      </section>

      <section>
        <h2>Friends</h2>
        <label>
          <input
            type="checkbox"
            checked={settings.friendSyncEnabled}
            onChange={(e) => updateSettings({ friendSyncEnabled: e.target.checked })}
          />
          Share session activity with my friends
        </label>
        <p>
          When on, generic session events (started, paused, distracted, completed, etc — never
          a site name or your goal text) sync to your friends, and the extension polls
          for their activity while a session is active. Off by default.
        </p>
      </section>

      <section>
        <h2>Notifications</h2>
        <p>
          These only control whether THIS device shows a notification toast for friend
          activity it has already received — they don't change what any friend can see. For
          per-friend visibility controls, see the Friends page.
        </p>
        <label>
          <input
            type="checkbox"
            checked={settings.liveNudgesNotificationsEnabled}
            onChange={(e) =>
              updateSettings({ liveNudgesNotificationsEnabled: e.target.checked })
            }
          />
          Show a notification when a friend sends me a live nudge
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.digestNotificationsEnabled}
            onChange={(e) => updateSettings({ digestNotificationsEnabled: e.target.checked })}
          />
          Show a notification for a friend's daily digest
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.quietHours !== null}
            onChange={(e) =>
              updateSettings({
                quietHours: e.target.checked ? { startHour: 22, endHour: 7 } : null,
              })
            }
          />
          Quiet hours (suppress notification toasts during a window)
        </label>
        {settings.quietHours && (
          <>
            <label>
              Quiet hours start (0-23, local time)
              <input
                type="number"
                min={0}
                max={23}
                value={settings.quietHours.startHour}
                onChange={(e) =>
                  updateSettings({
                    quietHours: {
                      ...settings.quietHours!,
                      startHour: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              Quiet hours end (0-23, local time)
              <input
                type="number"
                min={0}
                max={23}
                value={settings.quietHours.endHour}
                onChange={(e) =>
                  updateSettings({
                    quietHours: { ...settings.quietHours!, endHour: Number(e.target.value) },
                  })
                }
              />
            </label>
          </>
        )}
      </section>

      <section>
        <h2>Default restricted sites</h2>
        <textarea
          aria-label="Default restricted sites"
          value={settings.defaultRestrictedSites.join("\n")}
          onChange={(e) =>
            updateSettings({ defaultRestrictedSites: e.target.value.split("\n").filter(Boolean) })
          }
        />
      </section>

      {saveError && (
        <p role="alert">Couldn't save your changes: {saveError}. Please try again.</p>
      )}

      <section>
        <h2>Hard-block passcode</h2>
        <p>Share this with a friend, not with yourself. Setting a new passcode replaces the old one.</p>
        <input
          data-testid="old-passcode-input"
          type="password"
          placeholder="Current passcode (leave blank if you've never set one)"
          value={oldPasscode}
          onChange={(e) => setOldPasscode(e.target.value)}
        />
        <input
          data-testid="passcode-input"
          type="password"
          placeholder="Passcode"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
        <button onClick={handleSavePasscode} disabled={passcode.length < 4 || passcodeSaving}>
          {passcodeSaving ? "Saving…" : "Save passcode"}
        </button>
        {passcodeError && (
          <p role="alert">Couldn't save your passcode: {passcodeError}. Please try again.</p>
        )}
        {passcodeSaved && <p>Passcode saved.</p>}
      </section>
    </div>
  );
}
