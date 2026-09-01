import { Header } from "../../sidepanel/components/Header";
import { ButtonLarge } from "../../sidepanel/components/ui/ButtonLarge";

interface WelcomeScreenProps {
  onContinue: () => void;
}

// design-specs/frames/page-welcome.json (275:308) - instantiates the real header-bar (Header.tsx)
// rather than a static mockup of one; only OnboardingWizard.tsx mounts this, so Header's own
// useRefreshAll()/AUTH_GET_SESSION calls work the same as they do everywhere else in the panel
// (SidePanelApp.tsx wraps OnboardingWizard in the same RefreshRegistryProvider). "Log In" in the
// header does the same thing as "Continue" below - both just advance past Welcome.
export function WelcomeScreen({ onContinue }: WelcomeScreenProps) {
  return (
    <div className="onboarding-step onboarding-step--welcome">
      <h1>Welcome to</h1>
      <Header onSignInClick={onContinue} />
      <p>
        SnuffleStudy isn't a generic focus timer. It's consensual peer pressure — you tell
        Snuffles (and the friends you choose to loop in) what you're committing to, and let them
        hold you to it.
      </p>
      <p>
        The next few steps set up your study companion, your accountability style, and — if
        you're ready — a hard-block passcode.
      </p>
      <ButtonLarge onClick={onContinue}>Continue</ButtonLarge>
    </div>
  );
}
