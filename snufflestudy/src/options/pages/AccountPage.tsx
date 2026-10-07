import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { Profile } from "../../infrastructure/backend/profileApi";
import { SignInForm, type SignInFormSession } from "../../shared/ui/SignInForm";
import { Modal } from "../../sidepanel/components/ui/Modal";
import { ButtonLarge } from "../../sidepanel/components/ui/ButtonLarge";
import { Input } from "../../sidepanel/components/ui/Input";
import { useRefreshAllSafe } from "../../sidepanel/refresh/RefreshRegistryContext";

// The OTP email/code sign-in state and the AUTH_REQUEST_OTP/AUTH_VERIFY_OTP round trip live in
// the shared SignInForm - this page just holds the resulting session (its own concern: initial
// AUTH_GET_SESSION load, sign-out, etc.).
type AuthSession = SignInFormSession;

export function AccountPage() {
  // Header.tsx (a sibling, not an ancestor/descendant of this page) registers its own auth-
  // session check as a refresh function - this tells it (and anything else that cares) to
  // re-check right after sign-in/sign-out/delete-account, since Header would otherwise never
  // learn a sign-in that happened here actually happened. No-ops when there's no
  // RefreshRegistryProvider ancestor (OptionsApp.tsx's own standalone usage of this page).
  const refreshAllSafe = useRefreshAllSafe();

  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  // Same busy/error state shape as every other destructive action on this page (handleSignOut).
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);

  // Lets an already-signed-in user set or change their password. This is the recovery path for
  // an account that has no password yet (e.g. one signed in only via one-time code), and the
  // normal way to change a password afterward.
  // `passwordSetAt` is loaded from the signed-in user's profile (PROFILE_GET_MINE, below) as the
  // durable, server-side signal for whether a "Current password" field needs to be shown/
  // required at all. It's also updated locally to Date.now() on a successful set, which both
  // confirms the "Password updated." message and immediately flips a first-time set into
  // "current password now required" for any subsequent change, without waiting on a re-fetch.
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordSetAt, setPasswordSetAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    sendMessage<{ ok: boolean; session: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setSessionError(res.error ?? "Could not load your session.");
          return;
        }
        setSession(res.session);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated.
        console.error("Failed to load auth session", err);
        if (!cancelled) setSessionError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSessionLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Loads `passwordSetAt` from the signed-in user's profile once signed in - the password
  // section below (rendered further down, once `session` is set) needs this resolved before it
  // can decide whether to show/require the "Current password" field.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    sendMessage<{ ok: boolean; profile?: Profile | null; error?: string }>({
      type: "PROFILE_GET_MINE",
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          console.error("Failed to load your profile", res.error);
          return;
        }
        setPasswordSetAt(res.profile?.passwordSetAt ?? null);
      })
      .catch((err) => {
        console.error("Failed to load your profile", err);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  function handleSignedIn(newSession: SignInFormSession) {
    setSession(newSession);
    refreshAllSafe();
  }

  async function handleSignOut() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({ type: "AUTH_SIGN_OUT" });
      if (!res.ok) {
        setAuthError(res.error ?? "Could not sign out.");
        return;
      }
      setSession(null);
      setNewPassword("");
      setConfirmNewPassword("");
      setCurrentPassword("");
      setPasswordSetAt(null);
      refreshAllSafe();
    } catch (err) {
      console.error("Failed to sign out", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  // Sets or changes the signed-in user's password via AUTH_SET_PASSWORD (same message
  // SignInForm.tsx's create-account step uses). Submit is disabled until both fields are
  // non-empty and match - same "genuinely disabled, not just visually" contract as
  // SignInForm.tsx's own password step.
  // `currentPassword` is only sent when `passwordSetAt !== null` - there's nothing to verify
  // against otherwise (see messageRouter.ts's AUTH_SET_PASSWORD case), and sending an empty
  // string would read as "verify against an empty password" rather than "nothing to verify." On
  // success, `currentPassword` is cleared alongside `newPassword`/`confirmNewPassword` (its job
  // is done). On failure it's left as-is, same "don't wipe input on a failed attempt" convention
  // this form already follows for the other two fields - the field the user needs to look at
  // again (e.g. after "Current password is incorrect") is right there.
  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "AUTH_SET_PASSWORD",
        payload: {
          password: newPassword,
          ...(passwordSetAt !== null ? { currentPassword } : {}),
        },
      });
      if (!res.ok) {
        setPasswordError(res.error ?? "Could not set your password.");
        return;
      }
      setNewPassword("");
      setConfirmNewPassword("");
      setCurrentPassword("");
      setPasswordSetAt(Date.now());
    } catch (err) {
      console.error("Failed to set a password", err);
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasswordBusy(false);
    }
  }

  // Routes to AUTH_DELETE_ACCOUNT -> accountApi.deleteAccount() -> the delete-account Edge
  // Function. The confirmation step is rendered inline in this page's own JSX (deleteConfirming)
  // rather than as a browser-native window.confirm(), because Chrome silently suppresses
  // window.confirm()/alert()/prompt() with no visible dialog when this Options page is shown
  // embedded inside chrome://extensions (its default presentation).
  async function handleDeleteAccount() {
    setDeleteConfirming(false);
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "AUTH_DELETE_ACCOUNT",
      });
      if (!res.ok) {
        setDeleteError(res.error ?? "Could not delete your account.");
        return;
      }
      // The account no longer exists server-side at this point (and accountApi.deleteAccount()
      // already cleared the local Supabase session) - reset every piece of this page's own
      // account-scoped state so it renders back to the signed-out SignInForm, same as
      // handleSignOut.
      setSession(null);
      setNewPassword("");
      setConfirmNewPassword("");
      setCurrentPassword("");
      setPasswordSetAt(null);
      refreshAllSafe();
    } catch (err) {
      console.error("Failed to delete account", err);
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  if (!sessionLoaded) {
    return (
      <div className="account-page">
        <p>Loading…</p>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="account-page">
        <p role="alert">Couldn't load your account: {sessionError}. Please reload this page.</p>
      </div>
    );
  }

  return (
    <div className="account-page">
      <h2 className="sp-card__title">Account</h2>

      {!session && (
        <section>
          <SignInForm onSignedIn={handleSignedIn} />
        </section>
      )}

      {session && (
        <>
          <section className="account-page__options">
            <p className="sp-label">Signed in as {session.user.email ?? session.user.id}</p>
            <div className="account-page__button-row">
              <ButtonLarge onClick={() => void handleSignOut()} disabled={authBusy}>
                {authBusy ? "Signing out…" : "Sign Out"}
              </ButtonLarge>
              <ButtonLarge onClick={() => setDeleteConfirming(true)} disabled={deleteBusy}>
                Delete Account
              </ButtonLarge>
            </div>
            {authError && <p role="alert">Couldn't sign out: {authError}. Please try again.</p>}
            {deleteConfirming && (
              // Shared with the sidepanel's own Settings tab (SettingsTab.tsx mounts this same
              // AccountPage), not options-page-only.
              <Modal title="Are you sure?" onClose={() => setDeleteConfirming(false)}>
                <p>
                  This removes your friend connections, study room history, audio nudges,
                  digests, and every other record tied to your account, everywhere. This action
                  cannot be undone.
                </p>
                <ButtonLarge onClick={() => setDeleteConfirming(false)} disabled={deleteBusy}>
                  Go back
                </ButtonLarge>
                <ButtonLarge onClick={() => void handleDeleteAccount()} disabled={deleteBusy}>
                  {deleteBusy ? "Deleting…" : "Yes, delete my account"}
                </ButtonLarge>
              </Modal>
            )}
            {deleteError && (
              <p role="alert">Couldn't delete your account: {deleteError}. Please try again.</p>
            )}
          </section>

          <section className="account-page__password">
            <h3 className="sp-label">Account Password</h3>
            <form onSubmit={(e) => void handleSetPassword(e)} className="account-page__password-form">
              <div className="sp-password-grid">
                {passwordSetAt !== null && (
                  <>
                    <span className="sp-label">Old Password</span>
                    <Input
                      type="password"
                      required
                      aria-label="Old Password"
                      placeholder="Old Password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                  </>
                )}
                <span className="sp-label">New Password</span>
                <Input
                  type="password"
                  required
                  aria-label="New Password"
                  placeholder="New Password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <span className="sp-label">Confirm New</span>
                <Input
                  type="password"
                  required
                  aria-label="Confirm new password"
                  placeholder="Confirm new password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                />
              </div>
              <ButtonLarge
                type="submit"
                disabled={
                  passwordBusy ||
                  !newPassword ||
                  newPassword !== confirmNewPassword ||
                  (passwordSetAt !== null && !currentPassword)
                }
              >
                {passwordBusy ? "Saving…" : "Save Password"}
              </ButtonLarge>
            </form>
            {passwordError && (
              <p role="alert">Couldn't set your password: {passwordError}. Please try again.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
