import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { InviteCode } from "../../infrastructure/backend/friendshipApi";
import type { Profile } from "../../infrastructure/backend/profileApi";
import { SignInForm, type SignInFormSession } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";

// v3.2 Task 1: the OTP email/code sign-in state and AUTH_REQUEST_OTP/AUTH_VERIFY_OTP round trip
// this page used to own inline now live in the shared SignInForm - this page just holds the
// resulting session (still its own concern: initial AUTH_GET_SESSION load, sign-out, etc.).
type AuthSession = SignInFormSession;

export function AccountPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [inviteCode, setInviteCode] = useState<InviteCode | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);

  // v3.4 Task 2: flat "Your friends" list, replacing the group-scoped membersGroupId/"List
  // members"/"Leave" UI entirely - loaded via one FRIENDS_LIST call instead of a manually-entered
  // group id.
  const [friends, setFriends] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // v3.3 Task 8: resolves each friend's userId to their human_name (falling back to the raw id,
  // same as before this task, when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(friends ?? []);

  // v3.2 Task 8: account/data deletion. Same busy/error state shape as every other destructive
  // action on this page (handleSignOut, handleRemoveFriend).
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);

  // v3.3 Task 14: "set/change your password" for an already-signed-in user - the recovery path
  // for any account created before this feature shipped (no password yet, since a password used
  // to be optional), and the normal way to change a password later. No longer the primary way a
  // password gets set (that's now mandatory at signup, inside SignInForm.tsx's create-account
  // branch) - this is a secondary action, always available while signed in.
  // v3.4 Task 6: `passwordSetAt` is now also loaded from the signed-in user's profile
  // (PROFILE_GET_MINE, below) rather than starting purely local - it's the durable, server-side
  // signal for whether a "Current password" field needs to be shown/required at all. It's still
  // updated locally to Date.now() on a successful set (unchanged from before this task), which
  // both confirms the "Password updated." message and immediately flips a first-time set into
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

  // v3.4 Task 2: loads the flat "Your friends" list via one FRIENDS_LIST call once signed in -
  // replaces the old manually-entered "Friend list ID"/"List members" form entirely.
  function loadFriends() {
    setFriendsError(null);
    sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({ type: "FRIENDS_LIST" })
      .then((res) => {
        if (!res.ok) {
          setFriendsError(res.error ?? "Could not load friends.");
          return;
        }
        setFriends(res.friendIds ?? []);
      })
      .catch((err) => {
        console.error("Failed to load friends", err);
        setFriendsError(err instanceof Error ? err.message : String(err));
      });
  }

  useEffect(() => {
    if (session) loadFriends();
  }, [session]);

  // v3.4 Task 6: loads `passwordSetAt` from the signed-in user's profile once signed in - the
  // password section below (rendered further down, once `session` is set) needs this resolved
  // before it can decide whether to show/require the "Current password" field, same "fetch once
  // signed in" shape as loadFriends() above.
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
      setInviteCode(null);
      setFriends(null);
      setNewPassword("");
      setConfirmNewPassword("");
      setCurrentPassword("");
      setPasswordSetAt(null);
    } catch (err) {
      console.error("Failed to sign out", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  // v3.3 Task 14: sets or changes the signed-in user's password via AUTH_SET_PASSWORD (same
  // message SignInForm.tsx's create-account step uses). Submit is disabled until both fields are
  // non-empty and match - same "genuinely disabled, not just visually" contract as
  // SignInForm.tsx's own password step.
  // v3.4 Task 6: `currentPassword` is only sent when `passwordSetAt !== null` - there's nothing
  // to verify against otherwise (see messageRouter.ts's AUTH_SET_PASSWORD case), and sending an
  // empty string would read as "verify against an empty password" rather than "nothing to
  // verify." On success, `currentPassword` is cleared alongside `newPassword`/`confirmNewPassword`
  // (its job is done). On failure it's left as-is, same "don't wipe input on a failed attempt"
  // convention this form already follows for the other two fields - the field the user needs to
  // look at again (e.g. after "Current password is incorrect") is right there.
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

  // v3.2 Task 8: routes to AUTH_DELETE_ACCOUNT -> accountApi.deleteAccount() -> the
  // delete-account Edge Function. Confirmation step per this task's own DoD ("irreversible"),
  // rendered inline in this page's own JSX (deleteConfirming) rather than a browser-native
  // window.confirm() - QA-discovered bug (v3.2 Task 9): Chrome silently suppresses
  // confirm()/alert()/prompt() with no visible dialog at all when this Options page is shown
  // embedded inside chrome://extensions, which is its default presentation.
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
      setInviteCode(null);
      setFriends(null);
      setNewPassword("");
      setConfirmNewPassword("");
      setCurrentPassword("");
      setPasswordSetAt(null);
    } catch (err) {
      console.error("Failed to delete account", err);
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  // v3.4 Task 2: "Invite a friend" is now a single step (Decision 2) - generate a code directly,
  // no group to create first. Redemption connects the two users instantly (Decision 1: no
  // accept/decline step).
  async function handleInviteAFriend() {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const inviteRes = await sendMessage<{ ok: boolean; inviteCode?: InviteCode; error?: string }>({
        type: "FRIEND_INVITE_GENERATE_CODE",
      });
      if (!inviteRes.ok || !inviteRes.inviteCode) {
        setInviteError(inviteRes.error ?? "Could not generate an invite code.");
        return;
      }
      setInviteCode(inviteRes.inviteCode);
    } catch (err) {
      console.error("Failed to invite a friend", err);
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviteBusy(false);
    }
  }

  // v3.4 Task 2: "Add a friend" swaps GROUP_JOIN for FRIEND_REDEEM_CODE, and on success reloads
  // the flat friends list instead of remembering a single groupId.
  async function handleAddFriend(e: React.FormEvent) {
    e.preventDefault();
    setJoinBusy(true);
    setJoinError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "FRIEND_REDEEM_CODE",
        payload: { code: joinCode },
      });
      if (!res.ok) {
        setJoinError(res.error ?? "Could not add your friend with that code.");
        return;
      }
      setJoinCode("");
      loadFriends();
    } catch (err) {
      console.error("Failed to redeem an invite code", err);
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoinBusy(false);
    }
  }

  // v3.4 Task 2: "Remove friend" - either party can unilaterally end the friendship. On success,
  // filters the removed id out of local `friends` state (optimistic-on-confirmed-success, same
  // convention handleArchiveRoom in StudyRoomPanel.tsx already uses) rather than a full reload.
  async function handleRemoveFriend(friendId: string) {
    setRemovingId(friendId);
    setRemoveError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "FRIEND_REMOVE",
        payload: { friendUserId: friendId },
      });
      if (!res.ok) {
        setRemoveError(res.error ?? "Could not remove this friend.");
        return;
      }
      setFriends((prev) => (prev ? prev.filter((id) => id !== friendId) : prev));
    } catch (err) {
      console.error("Failed to remove a friend", err);
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingId(null);
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
      <h2>Account</h2>

      {!session && (
        <section>
          <SignInForm onSignedIn={handleSignedIn} />
        </section>
      )}

      {session && (
        <>
          <section>
            <p>Signed in as {session.user.email ?? session.user.id}.</p>
            <button type="button" onClick={() => void handleSignOut()} disabled={authBusy}>
              {authBusy ? "Signing out…" : "Sign out"}
            </button>
            {authError && <p role="alert">Couldn't sign out: {authError}. Please try again.</p>}
          </section>

          <section>
            <h3>Password</h3>
            <p>
              Set or change the password used by "Sign in with a password." If your account
              predates this feature, it may not have one yet - setting one here also fixes that.
            </p>
            <form onSubmit={(e) => void handleSetPassword(e)}>
              {passwordSetAt !== null && (
                <label>
                  Current password
                  <input
                    type="password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </label>
              )}
              <label>
                New password
                <input
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  required
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                />
              </label>
              <button
                type="submit"
                disabled={
                  passwordBusy ||
                  !newPassword ||
                  newPassword !== confirmNewPassword ||
                  (passwordSetAt !== null && !currentPassword)
                }
              >
                {passwordBusy ? "Saving…" : "Set password"}
              </button>
            </form>
            {passwordError && (
              <p role="alert">Couldn't set your password: {passwordError}. Please try again.</p>
            )}
            {passwordSetAt !== null && !passwordError && <p>Password updated.</p>}
          </section>

          <section>
            <h3>Delete account</h3>
            <p>
              Permanently deletes your account and every record tied to it across SnuffleStudy's
              servers - friend connections, study rooms, Producer Tags, digests, nudges, and
              everything else. This cannot be undone. See the Privacy page for the full list of
              what's stored and where.
            </p>
            {!deleteConfirming ? (
              <button type="button" onClick={() => setDeleteConfirming(true)} disabled={deleteBusy}>
                Delete account
              </button>
            ) : (
              <div role="alertdialog" aria-label="Confirm account deletion">
                <p>
                  <strong>Are you sure?</strong> This removes your friend connections (or hands
                  them off to another friend), study room history, Producer Tags, digests, and
                  every other record tied to your account, everywhere. This cannot be undone.
                </p>
                <button
                  type="button"
                  onClick={() => void handleDeleteAccount()}
                  disabled={deleteBusy}
                >
                  {deleteBusy ? "Deleting…" : "Yes, permanently delete my account"}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirming(false)}
                  disabled={deleteBusy}
                >
                  Cancel
                </button>
              </div>
            )}
            {deleteError && (
              <p role="alert">Couldn't delete your account: {deleteError}. Please try again.</p>
            )}
          </section>

          <section>
            <h3>Invite a friend</h3>
            <p>Generates a one-time invite code you can share with a friend to connect.</p>
            <button type="button" onClick={() => void handleInviteAFriend()} disabled={inviteBusy}>
              {inviteBusy ? "Setting up your invite…" : "Invite a friend"}
            </button>
            {inviteError && (
              <p role="alert">
                Couldn't generate an invite code: {inviteError}. Please try again.
              </p>
            )}
            {inviteCode && (
              <p>
                Invite code: <strong>{inviteCode.code}</strong> (expires{" "}
                {new Date(inviteCode.expiresAt).toLocaleString()})
              </p>
            )}
          </section>

          <section>
            <h3>Add a friend</h3>
            <form onSubmit={(e) => void handleAddFriend(e)}>
              <label>
                Invite code
                <input
                  type="text"
                  required
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                />
              </label>
              <button type="submit" disabled={joinBusy || !joinCode}>
                {joinBusy ? "Adding…" : "Add friend"}
              </button>
            </form>
            {joinError && (
              <p role="alert">Couldn't add your friend: {joinError}. Please try again.</p>
            )}
          </section>

          <section>
            <h3>Your friends</h3>
            {friendsError && <p role="alert">Couldn't load friends: {friendsError}. Please try again.</p>}
            {friends === null && !friendsError && <p>Loading…</p>}
            {friends !== null && friends.length === 0 && <p>No friends yet — invite one above.</p>}
            {friends !== null && friends.length > 0 && (
              <ul>
                {friends.map((friendId) => (
                  <li key={friendId}>
                    {displayName(friendId)}
                    <button
                      type="button"
                      onClick={() => void handleRemoveFriend(friendId)}
                      disabled={removingId === friendId}
                    >
                      {removingId === friendId ? "Removing…" : "Remove friend"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {removeError && (
              <p role="alert">Couldn't remove this friend: {removeError}. Please try again.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
