import { useEffect, useState } from "react";
import "../styles/global.css";
import type { UserSettings, TrackingTier } from "../domain/settings/userSettings";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import {
  requestDetailedTrackingPermission,
  revokeDetailedTrackingPermission,
} from "../infrastructure/browser/permissionsApi";
import {
  registerOverlayContentScript,
  unregisterOverlayContentScript,
} from "../background/contentScriptRegistration";

export function OptionsApp() {
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
        // or extension-context-invalidated. The whole page is gated behind this call
        // succeeding, so surface the failure instead of leaving the page stuck on
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
      <div className="options-app">
        <p role="alert">Couldn't load your settings: {settingsError}. Please reload this page.</p>
      </div>
    );
  }

  if (!settings) return <div className="options-app">Loading…</div>;

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
    <div className="options-app">
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
