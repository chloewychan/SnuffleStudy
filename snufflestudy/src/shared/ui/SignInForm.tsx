import { useState, type FormEvent } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

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
  // Called after a successful AUTH_VERIFY_OTP, with the resulting session - the caller needs
  // this to actually reflect the signed-in state (e.g. AccountPage.tsx's own `session` state),
  // not just a bare notification that signing in happened.
  onSignedIn: (session: SignInFormSession) => void;
  // Present only in the onboarding context: renders a "Skip for now" button (in both the
  // email-entry and code-entry sub-steps) when provided. Omitted entirely on AccountPage,
  // where there's nothing to skip to.
  onSkip?: () => void;
}

// Shared by AccountPage.tsx and OnboardingWizard.tsx's "account" step (v3.2 Task 1) - hoists
// the OTP email/code state and AUTH_REQUEST_OTP/AUTH_VERIFY_OTP round trip both call sites
// previously duplicated inline. Behavior is unchanged from each site's prior inline version;
// only the "Skip for now" button (onSkip) and the "Use a different email" button (shown when
// there's no onSkip, i.e. the AccountPage context, matching what each site rendered before)
// differ per call site.
export function SignInForm({ framingCopy, onSignedIn, onSkip }: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  // Shared by the initial "Send sign-in code" submit and the "Request a new code" resend button
  // (v3.2 Task 4) — both just re-fire AUTH_REQUEST_OTP for the current email. otpCode is reset
  // unconditionally on success: for the initial request it's already "" (nothing to reset), and
  // for a resend it clears out whatever stale code the user had typed against the old OTP. Left
  // untouched on failure — the resend button's own attempt failing shouldn't wipe input the user
  // may still want to retry with (e.g. a transient network error, not necessarily a bad code).
  async function requestOtp() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "AUTH_REQUEST_OTP",
        payload: { email },
      });
      if (!res.ok) {
        setAuthError(res.error ?? "Could not send a sign-in code.");
        return;
      }
      setOtpRequested(true);
      setOtpCode("");
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated.
      console.error("Failed to request a sign-in code", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRequestOtp(e: FormEvent) {
    e.preventDefault();
    await requestOtp();
  }

  async function handleVerifyOtp(e: FormEvent) {
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
      setOtpRequested(false);
      setOtpCode("");
      onSignedIn(res.session);
    } catch (err) {
      console.error("Failed to verify sign-in code", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <div className="sign-in-form">
      {framingCopy && <p>{framingCopy}</p>}
      {authError && (
        <p role="alert" className="sign-in-form__error">
          Couldn't sign in: {authError}. Please try again.
        </p>
      )}
      {!otpRequested ? (
        <form onSubmit={handleRequestOtp}>
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <div className="sign-in-form__actions">
            {onSkip && (
              <button type="button" onClick={onSkip} disabled={authBusy}>
                Skip for now
              </button>
            )}
            <button type="submit" disabled={authBusy || !email}>
              {authBusy ? "Sending…" : "Send sign-in code"}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleVerifyOtp}>
          <p>Check {email} for a 6-digit code.</p>
          <label>
            Code
            <input
              type="text"
              inputMode="numeric"
              required
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
            />
          </label>
          <div className="sign-in-form__actions">
            {onSkip && (
              <button type="button" onClick={onSkip} disabled={authBusy}>
                Skip for now
              </button>
            )}
            <button type="submit" disabled={authBusy || otpCode.length === 0}>
              {authBusy ? "Verifying…" : "Verify code"}
            </button>
            {/* Static label rather than an authBusy-driven one like the other buttons here:
                authBusy is shared with "Verify code" in this same view, so a busy-text swap
                here would misleadingly read "Sending…" while a verify attempt (not a resend)
                is actually in flight. Still correctly disabled during either action. */}
            <button type="button" onClick={() => requestOtp()} disabled={authBusy}>
              Request a new code
            </button>
            {!onSkip && (
              <button
                type="button"
                onClick={() => {
                  setOtpRequested(false);
                  setOtpCode("");
                  setAuthError(null);
                }}
              >
                Use a different email
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
