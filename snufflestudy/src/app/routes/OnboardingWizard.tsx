import { useState } from "react";
import type { TrackingTier } from "../../domain/settings/userSettings";
import { PRESSURE_PROFILES } from "../../domain/pressure/pressureProfiles";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { requestDetailedTrackingPermission } from "../../infrastructure/browser/permissionsApi";
import { registerOverlayContentScript } from "../../background/contentScriptRegistration";
import { WelcomeScreen } from "./WelcomeScreen";

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = "name" | "pressure" | "duration" | "tracking" | "sites" | "passcode" | "review";

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [showWelcome, setShowWelcome] = useState(true);
  const [step, setStep] = useState<Step>("name");
  // PRESSURE_PROFILES is a non-empty constant array defined in the domain module.
  const [pressureProfileId, setPressureProfileId] = useState(PRESSURE_PROFILES[0]!.id);
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [trackingTier, setTrackingTier] = useState<TrackingTier>("activity-only");
  const [restrictedSites, setRestrictedSites] = useState<string[]>([
    "youtube.com",
    "reddit.com",
    "tiktok.com",
  ]);
  const [passcode, setPasscode] = useState("");
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [passcodeSaving, setPasscodeSaving] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  async function setPasscodeAndContinue() {
    setPasscodeSaving(true);
    setPasscodeError(null);
    try {
      // First-time setup during onboarding never has an existing credential to prove
      // knowledge of first, so no oldPasscode is sent — same as OptionsApp's first-time-setup
      // path (see messageRouter's HARD_BLOCK_SET_PASSCODE handler).
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: "HARD_BLOCK_SET_PASSCODE",
        payload: { passcode },
      });
      if (!response.ok) {
        setPasscodeError(response.error ?? "Couldn't save your passcode.");
        return;
      }
      setStep("review");
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated. Surface it so the user isn't left unsure whether
      // their passcode actually saved, and don't advance past a step that may not have taken.
      console.error("Failed to save hard-block passcode during onboarding", err);
      setPasscodeError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasscodeSaving(false);
    }
  }

  async function finish() {
    setFinishing(true);
    setFinishError(null);
    try {
      let finalTrackingTier = trackingTier;
      if (trackingTier === "detailed") {
        const granted = await requestDetailedTrackingPermission();
        if (granted) {
          try {
            await registerOverlayContentScript();
          } catch (err) {
            // Registering the dynamic overlay content script (chrome.scripting.
            // registerContentScripts) is best-effort: onboarding completion (the part the
            // user actually asked for) should still go through even if this fails. A failure
            // here just means the Snuffles overlay won't appear until it's retried later
            // (e.g. from the options page) — not worth blocking onboarding over, so it's
            // logged rather than surfaced as `finishError`.
            console.error("Failed to register overlay content script", err);
          }
        } else {
          finalTrackingTier = "activity-only";
        }
      }

      await sendMessage({
        type: "SETTINGS_SAVE",
        payload: {
          pressureProfileId,
          trackingTier: finalTrackingTier,
          activityTrackingEnabled: true,
          defaultFocusDurationSeconds: focusMinutes * 60,
          defaultBreakDurationSeconds: 300,
          defaultAllowedSites: [],
          defaultRestrictedSites: finalTrackingTier === "detailed" ? restrictedSites : [],
          defaultRestrictionMode: "soft",
          onboardingCompleted: true,
          // Friend sync (v2 Task 6) is opt-in and configured separately from the options page's
          // "Friends" section, not part of the onboarding flow - defaults off, same as
          // DEFAULT_USER_SETTINGS.
          friendSyncEnabled: false,
          // v2 Task 10 Part C: notification preferences are configured separately from the
          // options page's "Notifications" section, not part of onboarding - defaults match
          // DEFAULT_USER_SETTINGS exactly.
          liveNudgesNotificationsEnabled: true,
          digestNotificationsEnabled: true,
          quietHours: null,
        },
      });

      onComplete();
    } catch (err) {
      // requestDetailedTrackingPermission (chrome.permissions.request) and sendMessage
      // (chrome.runtime.sendMessage) can both reject — e.g. service-worker startup races
      // or extension-context-invalidated. Surface it instead of leaving an unhandled
      // rejection and a button that silently did nothing.
      console.error("Failed to complete onboarding", err);
      setFinishError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinishing(false);
    }
  }

  if (showWelcome) {
    return <WelcomeScreen onContinue={() => setShowWelcome(false)} />;
  }

  if (step === "name") {
    return (
      <div className="onboarding-step">
        <h2>Meet Snuffles</h2>
        <p>Your study accountability companion.</p>
        <button onClick={() => setStep("pressure")}>Continue</button>
      </div>
    );
  }

  if (step === "pressure") {
    return (
      <div className="onboarding-step">
        <h2>Choose a pressure style</h2>
        <select value={pressureProfileId} onChange={(e) => setPressureProfileId(e.target.value)}>
          {PRESSURE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <button onClick={() => setStep("duration")}>Continue</button>
      </div>
    );
  }

  if (step === "duration") {
    return (
      <div className="onboarding-step">
        <h2>Default study duration</h2>
        <label>
          Minutes
          <input
            type="number"
            min={5}
            max={120}
            value={focusMinutes}
            onChange={(e) => setFocusMinutes(Number(e.target.value))}
          />
        </label>
        <button onClick={() => setStep("tracking")}>Continue</button>
      </div>
    );
  }

  if (step === "tracking") {
    return (
      <div className="onboarding-step">
        <h2>How should Snuffles track distraction?</h2>
        <label>
          <input
            type="radio"
            checked={trackingTier === "activity-only"}
            onChange={() => setTrackingTier("activity-only")}
          />
          Activity-only — no site permissions, just whether you're engaged
        </label>
        <label>
          <input
            type="radio"
            checked={trackingTier === "detailed"}
            onChange={() => setTrackingTier("detailed")}
          />
          Detailed site tracking — lets Snuffles tell allowed sites from restricted ones
        </label>
        <button onClick={() => setStep(trackingTier === "detailed" ? "sites" : "passcode")}>
          Continue
        </button>
      </div>
    );
  }

  if (step === "sites") {
    return (
      <div className="onboarding-step">
        <h2>Restricted sites</h2>
        <textarea
          value={restrictedSites.join("\n")}
          onChange={(e) => setRestrictedSites(e.target.value.split("\n").filter(Boolean))}
        />
        <button onClick={() => setStep("passcode")}>Continue</button>
      </div>
    );
  }

  if (step === "passcode") {
    return (
      <div className="onboarding-step">
        <h2>Set a hard-block passcode (optional)</h2>
        <p>
          Give this to a friend, not to yourself — they'll need it to unlock a hard-blocked site
          or end a hard-block session early. No one to share it with yet? Skip this and set one
          later in Settings.
        </p>
        {passcodeError && (
          <p role="alert" className="onboarding-step__error">
            Couldn't save your passcode: {passcodeError}. Please try again.
          </p>
        )}
        <input
          data-testid="onboarding-passcode-input"
          type="password"
          placeholder="Passcode"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
        <div className="onboarding-step__actions">
          <button onClick={() => setStep("review")} disabled={passcodeSaving}>
            Skip for now
          </button>
          <button
            onClick={setPasscodeAndContinue}
            disabled={passcode.length < 4 || passcodeSaving}
          >
            {passcodeSaving ? "Saving…" : "Set passcode"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-step">
      <h2>Ready to go</h2>
      <p>You can invite friends, and manage your hard-block passcode, later in Settings.</p>
      {finishError && (
        <p role="alert" className="onboarding-step__error">
          Couldn't save your settings: {finishError}. Please try again.
        </p>
      )}
      <button onClick={finish} disabled={finishing}>
        {finishing ? "Starting…" : "Start using SnuffleStudy"}
      </button>
    </div>
  );
}
