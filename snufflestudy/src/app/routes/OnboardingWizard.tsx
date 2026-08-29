import { useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { SignInForm } from "../../shared/ui/SignInForm";
import { WelcomeScreen } from "./WelcomeScreen";

interface OnboardingWizardProps {
  onComplete: () => void;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [showWelcome, setShowWelcome] = useState(true);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  async function finishOnboarding() {
    setFinishing(true);
    setFinishError(null);
    try {
      await sendMessage({
        type: "SETTINGS_SAVE",
        payload: {
          // v4.1 Task 3: onboarding no longer collects any of these - they're fixed defaults the
          // user can change later in Settings. Pressure style changes from the old
          // DEFAULT_USER_SETTINGS value (strict-coach) to gentle-encouragement (see
          // domain/settings/userSettings.ts); the rest already matched DEFAULT_USER_SETTINGS.
          pressureProfileId: "gentle-encouragement",
          trackingTier: "activity-only",
          activityTrackingEnabled: true,
          defaultFocusDurationSeconds: 1500,
          defaultBreakDurationSeconds: 300,
          defaultAllowedSites: [],
          defaultRestrictedSites: [],
          defaultRestrictionMode: "soft",
          onboardingCompleted: true,
          // Carried over unchanged from before this trim - not part of what onboarding used to
          // collect either; these already matched DEFAULT_USER_SETTINGS.
          friendSyncEnabled: false,
          liveNudgesNotificationsEnabled: true,
          digestNotificationsEnabled: true,
          quietHours: null,
        },
      });

      try {
        await sendMessage({ type: "TASK_CREATE", payload: { title: "Study with Snuffles" } });
      } catch (err) {
        // Seeding the default task is best-effort: onboarding completion (the part the user
        // actually asked for) should still go through even if this fails. A missing seed task
        // is a minor first-run gap, not worth re-showing onboarding or blocking the user from
        // starting the app over.
        console.error("Failed to seed default task during onboarding", err);
      }

      onComplete();
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
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

  return (
    <div className="onboarding-step">
      <h2>Sign in</h2>
      <SignInForm
        framingCopy="Sign in to use friends, rooms, nudges, approvals, and synced accountability features."
        onSignedIn={() => void finishOnboarding()}
        onSkip={() => void finishOnboarding()}
      />
      {finishError && (
        <p role="alert" className="onboarding-step__error">
          Couldn't save your settings: {finishError}. Please try again.
        </p>
      )}
      {finishing && <p aria-live="polite">Starting…</p>}
    </div>
  );
}
