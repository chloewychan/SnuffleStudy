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
import { HistoryPage } from "./pages/HistoryPage";
import { AccountPage } from "./pages/AccountPage";
import { FriendsPage } from "./pages/FriendsPage";
import { PrivacyPolicyPage } from "./pages/PrivacyPolicyPage";
import { isMediaPermissionError } from "../infrastructure/media/mediaPermissions";

type OptionsView = "settings" | "history" | "account" | "friends" | "privacy";

export function OptionsApp() {
  const [view, setView] = useState<OptionsView>("settings");
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [trackingChanging, setTrackingChanging] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [oldPasscode, setOldPasscode] = useState("");
  const [passcodeSaved, setPasscodeSaved] = useState(false);
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [passcodeSaving, setPasscodeSaving] = useState(false);

  // QA-discovered bug (v3.2 Task 9): Study Room video/audio and Producer Tag recording both call
  // getUserMedia() from the sidepanel, which - a documented Chrome platform limitation, not a
  // per-user mistake - can never display the permission prompt at all. This page (options.html)
  // opened as a real, full standalone tab CAN show it; the grant is per-origin, so once granted
  // here the sidepanel can use it without prompting again. See mediaPermissions.ts.
  const [mediaGrantStatus, setMediaGrantStatus] = useState<"idle" | "granting" | "granted" | "error">(
    "idle"
  );
  const [mediaGrantError, setMediaGrantError] = useState<string | null>(null);

  async function handleGrantMediaAccess() {
    setMediaGrantStatus("granting");
    setMediaGrantError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      // Only requesting the grant here - not actually starting a call or recording, so stop
      // every track immediately rather than leaving the camera/mic light on for no reason.
      stream.getTracks().forEach((track) => track.stop());
      setMediaGrantStatus("granted");
    } catch (err) {
      console.error("Failed to grant camera/microphone access", err);
      setMediaGrantStatus("error");
      setMediaGrantError(
        isMediaPermissionError(err)
          ? "Permission was denied. Check this tab's camera/microphone site settings and try again."
          : err instanceof Error
            ? err.message
            : String(err)
      );
    }
  }

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
      <nav className="options-app__nav">
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
          aria-current={view === "history" ? "page" : undefined}
          disabled={view === "history"}
          onClick={() => setView("history")}
        >
          History
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
          aria-current={view === "privacy" ? "page" : undefined}
          disabled={view === "privacy"}
          onClick={() => setView("privacy")}
        >
          Privacy
        </button>
      </nav>

      {view === "history" && <HistoryPage />}

      {view === "account" && <AccountPage />}

      {view === "friends" && <FriendsPage onSignInClick={() => setView("account")} />}

      {view === "privacy" && <PrivacyPolicyPage />}

      {view === "settings" && (
        <>
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
              Share session activity with my friend group
            </label>
            <p>
              When on, generic session events (started, paused, distracted, completed, etc — never
              a site name or your goal text) sync to your friend group, and the extension polls
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
            <h2>Camera &amp; microphone access</h2>
            <p>
              Study Rooms (video/audio) and Producer Tags (voice clips) need camera/microphone
              access. The side panel can't show that permission prompt itself — grant it once
              here, in this full tab, and the side panel will be able to use it afterward.
            </p>
            <button
              type="button"
              onClick={() => void handleGrantMediaAccess()}
              disabled={mediaGrantStatus === "granting"}
            >
              {mediaGrantStatus === "granting" ? "Requesting…" : "Grant camera & microphone access"}
            </button>
            {mediaGrantStatus === "granted" && (
              <p>Camera and microphone access granted — you can close this tab now.</p>
            )}
            {mediaGrantStatus === "error" && (
              <p role="alert">Couldn't grant access: {mediaGrantError}. Please try again.</p>
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
        </>
      )}
    </div>
  );
}
