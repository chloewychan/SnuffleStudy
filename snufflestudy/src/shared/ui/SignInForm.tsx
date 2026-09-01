import { useId, useState, type FormEvent } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { ButtonIcon } from "../../sidepanel/components/ui/ButtonIcon";
import { ButtonLarge } from "../../sidepanel/components/ui/ButtonLarge";
import { ButtonSmall } from "../../sidepanel/components/ui/ButtonSmall";
import { Input } from "../../sidepanel/components/ui/Input";

// Minimal shape of what supabase-js's Session/User actually returns - only the fields this
// form ever hands back to its caller after a successful sign-in. Mirrors the shape
// AccountPage.tsx/OnboardingWizard.tsx each defined locally before this extraction (the real
// objects carry access/refresh tokens too, which nothing here or its callers ever need to
// touch - the background's supabaseClient.ts owns the actual session object).
export interface SignInFormUser {
  id: string;
  email?: string;
}
export interface SignInFormSession {
  user: SignInFormUser;
}

interface SignInFormProps {
  // Shown above the form. Omitted on AccountPage; set to the fixed onboarding copy when
  // rendered from OnboardingWizard.
  framingCopy?: string;
  // Called once an account is actually usable - after AUTH_VERIFY_OTP on the sign-in branch
  // (account already exists), after AUTH_SIGN_IN_PASSWORD, or after both AUTH_SET_PASSWORD and
  // PROFILE_SAVE_MINE succeed on the create-account branch (a verified-but-passwordless,
  // profile-less account isn't "signed in" yet from this form's point of view - see
  // completeAccountCreation below).
  onSignedIn: (session: SignInFormSession) => void;
  // Present only in the onboarding context: renders a "Skip for now" button at every step
  // (including the initial Create account/Sign in choice) when provided. Omitted entirely on
  // AccountPage, where there's nothing to skip to.
  onSkip?: () => void;
  // Present only in the onboarding context: design-specs/frames/page-sign-in.json's back button
  // on the entry "choice" step goes back to page-welcome (WelcomeScreen), which only
  // OnboardingWizard.tsx can wire up. Every other step's own back button (choice, not welcome)
  // works everywhere regardless of this prop - see handleBack.
  onBack?: () => void;
}

// v3.3 Task 14 (Decision 6): the Create-account/Sign-in choice lives inside this component, not
// as a caller-supplied prop - every call site (AccountPage.tsx, OnboardingWizard.tsx, and any
// future one) gets both flows automatically, with no risk of a call site being wired to the
// wrong mode.
//
// design-specs/frames/page-sign-in.json merges what used to be two nested choice screens
// ("choice" -> "signin-choice") into one: Create account / Sign in with password / Sign in with
// a one-time code, all three peers on the entry screen. signin-choice no longer exists as a mode.
//
// - "choice": entry state - Create account / Sign in with password / Sign in with a code.
// - "create-details" -> "create-code": v3.4 Task 7 consolidated account creation onto one screen
//   ahead of the OTP step - name/bunny name/email/password/confirm password are all collected
//   together on "create-details", then "create-code"'s verified OTP completes account creation
//   automatically (see completeAccountCreation/handleCreateVerifyOtp below) - no separate
//   password step after code verification anymore. email/otpCode are shared with the sign-in
//   branch's own code round trip below (only one branch is ever visible at a time, and both
//   round trips are functionally identical AUTH_REQUEST_OTP/AUTH_VERIFY_OTP calls against
//   whatever email is currently entered).
// - "signin-password": AUTH_SIGN_IN_PASSWORD, its own email/password fields (kept separate from
//   the create-account email field so switching branches doesn't leak a partially-typed email
//   between unrelated flows).
// - "signin-otp-email" -> "signin-otp-code": today's AUTH_REQUEST_OTP/AUTH_VERIFY_OTP round trip,
//   unchanged - calls onSignedIn directly on verify, no password step (the account already
//   exists).
type Mode =
  | "choice"
  | "create-details"
  | "create-code"
  | "signin-password"
  | "signin-otp-email"
  | "signin-otp-code";

// design-specs/frames/page-sign-in*.json / page-create-new-account*.json's per-step Pangolin
// title, next to the back button.
const STEP_TITLE: Record<Mode, string> = {
  choice: "Sign In",
  "create-details": "Create New Account",
  "create-code": "Create New Account",
  "signin-password": "Sign In With Password",
  "signin-otp-email": "Sign In With One-Time Code",
  "signin-otp-code": "Sign In With One-Time Code",
};

export function SignInForm({ framingCopy, onSignedIn, onSkip, onBack }: SignInFormProps) {
  const [mode, setMode] = useState<Mode>("choice");

  // Shared by both the create-account branch's mandatory code step and the sign-in branch's
  // "Email me a code" option - see the Mode comment above for why sharing this state is safe.
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  // v3.4 Task 7: holds the session AUTH_VERIFY_OTP already returned, once verification succeeds -
  // kept around (not handed to onSignedIn immediately) specifically so a failed completion step
  // (AUTH_SET_PASSWORD or PROFILE_SAVE_MINE) can be retried WITHOUT re-calling AUTH_VERIFY_OTP,
  // which would either fail outright (an OTP code is single-use server-side) or, worse, require
  // the user to request and enter an entirely new code for a failure that has nothing to do with
  // the code itself. Distinct in purpose from the old (now-removed) pendingCreateSession, which
  // existed to gate a manual next step the user drove themselves - this exists purely to make
  // automatic completion retryable. Also doubles as the "create-code" step's signal for whether
  // to render "Verify Code" (not yet verified) or "Retry" (verified, completion failed).
  const [verifiedSession, setVerifiedSession] = useState<SignInFormSession | null>(null);

  // Create-account branch's "create-details" step fields - name/bunny name collected up front,
  // alongside email/password, since v3.4 Task 7 put everything on one screen ahead of the OTP
  // step instead of splitting profile setup into its own post-verification step.
  const [humanName, setHumanName] = useState("");
  const [bunnyName, setBunnyName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Sign-in branch's "Sign in with a password" option - its own email field, deliberately not
  // shared with `email` above (see the Mode comment).
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");

  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const idPrefix = useId();
  const nameFieldId = `${idPrefix}-name`;
  const bunnyNameFieldId = `${idPrefix}-bunny-name`;
  const createEmailFieldId = `${idPrefix}-create-email`;
  const createPasswordFieldId = `${idPrefix}-create-password`;
  const confirmPasswordFieldId = `${idPrefix}-confirm-password`;
  const createCodeFieldId = `${idPrefix}-create-code`;
  const signInEmailFieldId = `${idPrefix}-signin-email`;
  const signInPasswordFieldId = `${idPrefix}-signin-password`;
  const otpEmailFieldId = `${idPrefix}-otp-email`;
  const signInCodeFieldId = `${idPrefix}-signin-code`;

  // Shared by every "send a code"/"resend a code" action across both branches - just fires
  // AUTH_REQUEST_OTP for the current `email`. otpCode is reset unconditionally on success (v3.2
  // Task 4 behavior, unchanged): for an initial request it's already "" (nothing to reset), and
  // for a resend it clears out whatever stale code the user had typed against the old OTP. Left
  // untouched on failure - the resend button's own attempt failing shouldn't wipe input the user
  // may still want to retry with (e.g. a transient network error, not necessarily a bad code).
  // Returns whether the request succeeded, so callers that need to advance `mode` only do so on
  // success.
  async function requestOtp(): Promise<boolean> {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "AUTH_REQUEST_OTP",
        payload: { email },
      });
      if (!res.ok) {
        setAuthError(res.error ?? "Could not send a sign-in code.");
        return false;
      }
      setOtpCode("");
      return true;
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated.
      console.error("Failed to request a sign-in code", err);
      setAuthError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCreateRequestOtp(e: FormEvent) {
    e.preventDefault();
    if (await requestOtp()) setMode("create-code");
  }

  // v3.4 Task 7: the create-account branch's completion step - fires automatically the moment
  // AUTH_VERIFY_OTP succeeds (see handleCreateVerifyOtp below), and again directly from the
  // "create-code" step's "Retry" button if it fails partway. Takes `session` as a parameter
  // (rather than reading verifiedSession itself) so both callers can pass the exact session they
  // have in hand without a stale-closure risk. Owns its own authBusy/authError lifecycle - on
  // either failure it sets an inline error and returns WITHOUT clearing password/confirmPassword/
  // verifiedSession and WITHOUT calling onSignedIn, so the Retry button can call this again with
  // the same session and the same already-typed password.
  async function completeAccountCreation(session: SignInFormSession) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      // No currentPassword - a brand-new account has none to prove, Task 6's messageRouter.ts
      // AUTH_SET_PASSWORD handler is a no-op on that check when profiles.password_set_at is null.
      const passwordRes = await sendMessage<{ ok: boolean; error?: string }>({
        type: "AUTH_SET_PASSWORD",
        payload: { password },
      });
      if (!passwordRes.ok) {
        setAuthError(
          passwordRes.error ?? "Could not finish creating your account. Please try again."
        );
        return;
      }
      const profileRes = await sendMessage<{ ok: boolean; error?: string }>({
        type: "PROFILE_SAVE_MINE",
        payload: { humanName, bunnyName: bunnyName || undefined },
      });
      if (!profileRes.ok) {
        setAuthError(
          profileRes.error ?? "Could not finish creating your account. Please try again."
        );
        return;
      }
      setOtpCode("");
      setPassword("");
      setConfirmPassword("");
      setVerifiedSession(null);
      onSignedIn(session);
    } catch (err) {
      console.error("Failed to finish creating the account", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCreateVerifyOtp(e: FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await sendMessage<{
        ok: boolean;
        session?: SignInFormSession;
        error?: string;
      }>({
        type: "AUTH_VERIFY_OTP",
        payload: { email, token: otpCode },
      });
      if (!res.ok || !res.session) {
        // Wrong/expired code: reset authBusy here too (not just in the catch block below) so
        // the "Verify Code" button doesn't stay stuck disabled/"Verifying…" - there's no shared
        // finally covering this early return, since the success path below deliberately hands
        // authBusy off to completeAccountCreation's own lifecycle instead.
        setAuthError(res.error ?? "Incorrect or expired code.");
        setAuthBusy(false);
        return;
      }
      // The email is now proven - hand off to completeAccountCreation, which owns its own
      // authBusy/authError lifecycle from here (see its finally block instead of duplicating
      // one here). verifiedSession is set first so the "create-code" step's retry affordance is
      // available even if completeAccountCreation itself throws.
      setVerifiedSession(res.session);
      setAuthBusy(false);
      await completeAccountCreation(res.session);
      return;
    } catch (err) {
      console.error("Failed to verify sign-in code", err);
      setAuthError(err instanceof Error ? err.message : String(err));
      setAuthBusy(false);
    }
  }

  async function handleSignInPassword(e: FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await sendMessage<{
        ok: boolean;
        session?: SignInFormSession;
        error?: string;
      }>({
        type: "AUTH_SIGN_IN_PASSWORD",
        payload: { email: signInEmail, password: signInPassword },
      });
      if (!res.ok || !res.session) {
        setAuthError(res.error ?? "Incorrect email or password.");
        return;
      }
      setSignInPassword("");
      onSignedIn(res.session);
    } catch (err) {
      console.error("Failed to sign in with a password", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignInRequestOtp(e: FormEvent) {
    e.preventDefault();
    if (await requestOtp()) setMode("signin-otp-code");
  }

  async function handleSignInVerifyOtp(e: FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await sendMessage<{
        ok: boolean;
        session?: SignInFormSession;
        error?: string;
      }>({
        type: "AUTH_VERIFY_OTP",
        payload: { email, token: otpCode },
      });
      if (!res.ok || !res.session) {
        setAuthError(res.error ?? "Incorrect or expired code.");
        return;
      }
      // Sign-in branch: the account already exists - no password step tacked on here.
      setOtpCode("");
      onSignedIn(res.session);
    } catch (err) {
      console.error("Failed to verify sign-in code", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  // design-specs/frames/page-sign-in*.json / page-create-new-account*.json each show one back
  // button per step - "choice"'s goes to page-welcome (only OnboardingWizard.tsx can wire that,
  // via onBack); every other step's own back button returns to whichever step preceded it, the
  // same everywhere regardless of onBack.
  function handleBack() {
    setAuthError(null);
    if (mode === "choice") {
      onBack?.();
      return;
    }
    if (mode === "create-code") {
      setMode("create-details");
      return;
    }
    if (mode === "signin-otp-code") {
      setMode("signin-otp-email");
      return;
    }
    setMode("choice");
  }

  const showBack = mode !== "choice" || Boolean(onBack);

  function StepHeader() {
    return (
      <div className="sign-in-form__step-header">
        {showBack && <ButtonIcon icon="back" aria-label="Back" onClick={handleBack} disabled={authBusy} />}
        <h2>{STEP_TITLE[mode]}</h2>
      </div>
    );
  }

  const skipButton = onSkip ? (
    <ButtonSmall type="button" colour="beige" onClick={onSkip} disabled={authBusy}>
      Skip for now
    </ButtonSmall>
  ) : null;

  return (
    <div className="sign-in-form">
      {authError && (
        <p role="alert" className="sign-in-form__error">
          Couldn't sign in: {authError}. Please try again.
        </p>
      )}

      {mode === "choice" && (
        <>
          <StepHeader />
          {framingCopy && <p className="sign-in-form__framing">{framingCopy}</p>}
          <div className="sign-in-form__actions">
            <ButtonLarge onClick={() => setMode("create-details")}>Create new account</ButtonLarge>
            <ButtonLarge onClick={() => setMode("signin-password")}>
              Sign in (with password)
            </ButtonLarge>
            <ButtonLarge onClick={() => setMode("signin-otp-email")}>
              Sign in (one-time code)
            </ButtonLarge>
          </div>
          {skipButton && <div className="sign-in-form__skip">{skipButton}</div>}
        </>
      )}

      {mode === "create-details" && (
        <form onSubmit={handleCreateRequestOtp}>
          <StepHeader />
          <div className="sp-form-fields">
            <label htmlFor={nameFieldId}>Your Name</label>
            <Input
              id={nameFieldId}
              type="text"
              required
              value={humanName}
              onChange={(e) => setHumanName(e.target.value)}
            />
            <label htmlFor={bunnyNameFieldId}>Bunny Name</label>
            <Input
              id={bunnyNameFieldId}
              type="text"
              value={bunnyName}
              onChange={(e) => setBunnyName(e.target.value)}
            />
            <label htmlFor={createEmailFieldId}>Email</label>
            <Input
              id={createEmailFieldId}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label htmlFor={createPasswordFieldId}>Password</label>
            <Input
              id={createPasswordFieldId}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <label htmlFor={confirmPasswordFieldId}>Confirm Password</label>
            <Input
              id={confirmPasswordFieldId}
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <div className="sign-in-form__actions">
            <ButtonLarge
              type="submit"
              disabled={authBusy || !humanName || !email || !password || password !== confirmPassword}
            >
              {authBusy ? "Sending…" : "Send Sign-In Code"}
            </ButtonLarge>
          </div>
          {skipButton && <div className="sign-in-form__skip">{skipButton}</div>}
        </form>
      )}

      {mode === "create-code" && (
        <form onSubmit={handleCreateVerifyOtp}>
          <StepHeader />
          <p>Check {email} for an 8-digit code.</p>
          <div className="sp-form-fields">
            <label htmlFor={createCodeFieldId}>Code</label>
            <Input
              id={createCodeFieldId}
              type="text"
              inputMode="numeric"
              required
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
            />
          </div>
          <div className="sign-in-form__actions sign-in-form__actions--row">
            <ButtonLarge type="button" onClick={() => requestOtp()} disabled={authBusy}>
              Request a New Code
            </ButtonLarge>
            {verifiedSession ? (
              // v3.4 Task 7: the code is already verified - retry ONLY the completion step
              // (password + profile), never AUTH_VERIFY_OTP again (see completeAccountCreation's
              // own comment for why - the code is single-use server-side).
              <ButtonLarge
                type="button"
                onClick={() => void completeAccountCreation(verifiedSession)}
                disabled={authBusy}
              >
                {authBusy ? "Finishing…" : "Retry"}
              </ButtonLarge>
            ) : (
              <ButtonLarge type="submit" disabled={authBusy || otpCode.length === 0}>
                {authBusy ? "Verifying…" : "Verify Code"}
              </ButtonLarge>
            )}
          </div>
          {skipButton && <div className="sign-in-form__skip">{skipButton}</div>}
        </form>
      )}

      {mode === "signin-password" && (
        <form onSubmit={handleSignInPassword}>
          <StepHeader />
          <div className="sp-form-fields">
            <label htmlFor={signInEmailFieldId}>Email</label>
            <Input
              id={signInEmailFieldId}
              type="email"
              required
              value={signInEmail}
              onChange={(e) => setSignInEmail(e.target.value)}
            />
            <label htmlFor={signInPasswordFieldId}>Password</label>
            <Input
              id={signInPasswordFieldId}
              type="password"
              required
              value={signInPassword}
              onChange={(e) => setSignInPassword(e.target.value)}
            />
          </div>
          <div className="sign-in-form__actions">
            <ButtonLarge type="submit" disabled={authBusy || !signInEmail || !signInPassword}>
              {authBusy ? "Signing in…" : "Sign In"}
            </ButtonLarge>
          </div>
          {skipButton && <div className="sign-in-form__skip">{skipButton}</div>}
        </form>
      )}

      {mode === "signin-otp-email" && (
        <form onSubmit={handleSignInRequestOtp}>
          <StepHeader />
          <div className="sp-form-fields">
            <label htmlFor={otpEmailFieldId}>Email</label>
            <Input
              id={otpEmailFieldId}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="sign-in-form__actions">
            <ButtonLarge type="submit" disabled={authBusy || !email}>
              {authBusy ? "Sending…" : "Send Sign-In Code"}
            </ButtonLarge>
          </div>
          {skipButton && <div className="sign-in-form__skip">{skipButton}</div>}
        </form>
      )}

      {mode === "signin-otp-code" && (
        <form onSubmit={handleSignInVerifyOtp}>
          <StepHeader />
          <p>Check {email} for an 8-digit code.</p>
          <div className="sp-form-fields">
            <label htmlFor={signInCodeFieldId}>Code</label>
            <Input
              id={signInCodeFieldId}
              type="text"
              inputMode="numeric"
              required
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
            />
          </div>
          <div className="sign-in-form__actions sign-in-form__actions--row">
            <ButtonLarge type="button" onClick={() => requestOtp()} disabled={authBusy}>
              Request a New Code
            </ButtonLarge>
            <ButtonLarge type="submit" disabled={authBusy || otpCode.length === 0}>
              {authBusy ? "Verifying…" : "Verify Code"}
            </ButtonLarge>
          </div>
          {skipButton && <div className="sign-in-form__skip">{skipButton}</div>}
        </form>
      )}
    </div>
  );
}
