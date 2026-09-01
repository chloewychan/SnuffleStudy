import { useState } from "react";
import "../styles/global.css";
// AccountPage.tsx renders SignInForm, which composes the ui/ primitives from
// src/sidepanel/components/ui/ (design-specs/) - their styles live in sidepanel.css, same
// precedent as SettingsPage.tsx being shared across both entrypoints below.
import "../styles/sidepanel.css";
import { HistoryPage } from "./pages/HistoryPage";
import { AccountPage } from "./pages/AccountPage";
import { FriendsPage } from "./pages/FriendsPage";
import { PrivacyPolicyPage } from "./pages/PrivacyPolicyPage";
import { SettingsPage } from "../sidepanel/components/settingsTab/SettingsPage";
import { ButtonLarge } from "../sidepanel/components/ui/ButtonLarge";
import { isMediaPermissionError } from "../infrastructure/media/mediaPermissions";

type OptionsView = "settings" | "history" | "account" | "friends" | "privacy";

// v3.3 Task 7: the inline Tracking/Friends/Notifications/Default-restricted-sites/Hard-block-
// passcode UI that used to live directly in this "settings" view (its own settings/trackingChanging/
// passcode state, SETTINGS_GET/SETTINGS_SAVE/HARD_BLOCK_SET_PASSCODE handlers) has moved verbatim
// into SettingsPage.tsx, shared with the sidepanel's new SettingsTab.tsx sub-nav. Only the camera/
// microphone section stays inline here - it's a full-tab-only affordance (see mediaGrantStatus
// below), so it renders after <SettingsPage /> rather than as part of it.
export function OptionsApp() {
  const [view, setView] = useState<OptionsView>("settings");

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
          <SettingsPage />

          <section>
            <h2 className="sp-label">Camera &amp; Microphone</h2>
            <p>
              Study Rooms (video/audio) and audio nudges (voice clips) need camera/microphone
              access. The side panel can't show that permission prompt itself — grant it once
              here, in this full tab, and the side panel will be able to use it afterward.
            </p>
            <ButtonLarge
              onClick={() => void handleGrantMediaAccess()}
              disabled={mediaGrantStatus === "granting"}
            >
              {mediaGrantStatus === "granting" ? "Requesting…" : "Grant Camera & Microphone Access"}
            </ButtonLarge>
            {mediaGrantStatus === "granted" && (
              <p>Camera and microphone access granted — you can close this tab now.</p>
            )}
            {mediaGrantStatus === "error" && (
              <p role="alert">Couldn't grant access: {mediaGrantError}. Please try again.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
