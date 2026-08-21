interface WelcomeScreenProps {
  onContinue: () => void;
}

export function WelcomeScreen({ onContinue }: WelcomeScreenProps) {
  return (
    <div className="onboarding-step onboarding-step--welcome">
      <h1>Welcome to SnuffleStudy</h1>
      <p>
        SnuffleStudy isn't a generic focus timer. It's consensual peer pressure — you tell
        Snuffles (and the friends you choose to loop in) what you're committing to, and let them
        hold you to it.
      </p>
      <p>
        The next few steps set up your study companion, your accountability style, and — if
        you're ready — a hard-block passcode.
      </p>
      <button onClick={onContinue}>Get started</button>
    </div>
  );
}
