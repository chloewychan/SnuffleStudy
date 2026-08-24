import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type {
  FriendGroup,
  GroupMembership,
  InviteCode,
} from "../../infrastructure/backend/friendGroupApi";
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

  const [group, setGroup] = useState<FriendGroup | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);

  const [inviteCode, setInviteCode] = useState<InviteCode | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);

  const [membersGroupId, setMembersGroupId] = useState("");
  const [members, setMembers] = useState<GroupMembership[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);

  // v3.3 Task 8: resolves each friend's userId to their human_name (falling back to the raw id,
  // same as before this task, when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames((members ?? []).map((m) => m.userId));

  // v2 follow-up (Item 2, post-final-review): self-leave only - reuses membersGroupId (the same
  // manual-entry field "List members" already uses) rather than adding a second group-id input.
  // Owner-removes-a-specific-member (kick) has no obvious home in this manual-entry-only UI (there
  // is no per-row member list beyond the raw `members` array below) - GROUP_LEAVE's targetUserId
  // stays capable of it, this page just doesn't build a control for it, per this dispatch's
  // "primary must-have is self-leave, kick UI is a skippable nice-to-have" guidance.
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leftGroupId, setLeftGroupId] = useState<string | null>(null);
  const [leaveConfirming, setLeaveConfirming] = useState(false);

  // v3.2 Task 8: account/data deletion. Same busy/error state shape as every other destructive
  // action on this page (handleSignOut, handleLeaveGroup).
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);

  // v3.3 Task 14: "set/change your password" for an already-signed-in user - the recovery path
  // for any account created before this feature shipped (no password yet, since a password used
  // to be optional), and the normal way to change a password later. No longer the primary way a
  // password gets set (that's now mandatory at signup, inside SignInForm.tsx's create-account
  // branch) - this is a secondary action, always available while signed in.
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
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
      setGroup(null);
      setInviteCode(null);
      setMembers(null);
      setNewPassword("");
      setConfirmNewPassword("");
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
  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "AUTH_SET_PASSWORD",
        payload: { password: newPassword },
      });
      if (!res.ok) {
        setPasswordError(res.error ?? "Could not set your password.");
        return;
      }
      setNewPassword("");
      setConfirmNewPassword("");
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
  // window.confirm() - see handleLeaveGroup's comment above for why: Chrome silently suppresses
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
      setGroup(null);
      setInviteCode(null);
      setMembers(null);
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordSetAt(null);
    } catch (err) {
      console.error("Failed to delete account", err);
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  // v3.3 Task 5: "Invite a friend" collapses what used to be two separate steps (create a
  // named group, then separately click "Generate invite code") into one action. The friend
  // group this still creates underneath is an implementation detail - its name is
  // auto-generated and never shown anywhere in this UI; only the resulting invite code is
  // (see docs/implementation_plans/V3.3_Implementation_Plan.md Task 5). The real
  // pairwise-friendship rebuild that would remove the group entirely is out of scope this
  // version.
  async function handleInviteAFriend() {
    setGroupBusy(true);
    setGroupError(null);
    setInviteError(null);
    try {
      const autoName = `Friends of ${session?.user.email ?? "me"}`;
      const createRes = await sendMessage<{ ok: boolean; group?: FriendGroup; error?: string }>({
        type: "GROUP_CREATE",
        payload: { name: autoName },
      });
      if (!createRes.ok || !createRes.group) {
        setGroupError(createRes.error ?? "Could not set up a friend invite.");
        return;
      }
      setGroup(createRes.group);
      setMembersGroupId(createRes.group.id);

      setInviteBusy(true);
      const inviteRes = await sendMessage<{ ok: boolean; inviteCode?: InviteCode; error?: string }>({
        type: "GROUP_GENERATE_INVITE_CODE",
        payload: { groupId: createRes.group.id },
      });
      if (!inviteRes.ok || !inviteRes.inviteCode) {
        setInviteError(inviteRes.error ?? "Could not generate an invite code.");
        return;
      }
      setInviteCode(inviteRes.inviteCode);
    } catch (err) {
      console.error("Failed to invite a friend", err);
      setGroupError(err instanceof Error ? err.message : String(err));
    } finally {
      setGroupBusy(false);
      setInviteBusy(false);
    }
  }

  async function handleJoinGroup(e: React.FormEvent) {
    e.preventDefault();
    setJoinBusy(true);
    setJoinError(null);
    try {
      const res = await sendMessage<{ ok: boolean; membership?: GroupMembership; error?: string }>({
        type: "GROUP_JOIN",
        payload: { code: joinCode },
      });
      if (!res.ok || !res.membership) {
        setJoinError(res.error ?? "Could not join with that code.");
        return;
      }
      setMembersGroupId(res.membership.groupId);
      setJoinCode("");
    } catch (err) {
      console.error("Failed to join group", err);
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoinBusy(false);
    }
  }

  async function handleListMembers(e: React.FormEvent) {
    e.preventDefault();
    setMembersBusy(true);
    setMembersError(null);
    try {
      const res = await sendMessage<{ ok: boolean; members?: GroupMembership[]; error?: string }>({
        type: "GROUP_LIST_MEMBERS",
        payload: { groupId: membersGroupId },
      });
      if (!res.ok || !res.members) {
        setMembersError(res.error ?? "Could not load members.");
        return;
      }
      setMembers(res.members);
    } catch (err) {
      console.error("Failed to load group members", err);
      setMembersError(err instanceof Error ? err.message : String(err));
    } finally {
      setMembersBusy(false);
    }
  }

  // QA-discovered bug (v3.2 Task 9): this used to gate on window.confirm(), but Chrome silently
  // no-ops synchronous confirm()/alert()/prompt() calls - no dialog, no error, nothing - when
  // this Options page is shown embedded inside chrome://extensions (options_ui.open_in_tab is
  // false, WXT's default, never overridden in wxt.config.ts), which is how Chrome opens an
  // extension's Options page by default. The `if (!window.confirm(...)) return` guard always
  // silently short-circuited in that context, so the button appeared to do nothing at all.
  // Fixed by moving the confirmation into this page's own JSX (leaveConfirming) instead of a
  // browser-native dialog, which works identically regardless of how this page is being shown.
  async function handleLeaveGroup() {
    if (!membersGroupId) return;
    setLeaveConfirming(false);
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "GROUP_LEAVE",
        payload: { groupId: membersGroupId },
      });
      if (!res.ok) {
        setLeaveError(res.error ?? "Could not leave your friends list.");
        return;
      }
      setLeftGroupId(membersGroupId);
      setMembers(null);
      if (group?.id === membersGroupId) {
        setGroup(null);
        setInviteCode(null);
      }
    } catch (err) {
      console.error("Failed to leave group", err);
      setLeaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setLeaveBusy(false);
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
                  newPassword !== confirmNewPassword
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
            <button
              type="button"
              onClick={() => void handleInviteAFriend()}
              disabled={groupBusy || inviteBusy}
            >
              {groupBusy || inviteBusy ? "Setting up your invite…" : "Invite a friend"}
            </button>
            {groupError && (
              <p role="alert">Couldn't set up a friend invite: {groupError}. Please try again.</p>
            )}
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
            <form onSubmit={handleJoinGroup}>
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
            <form onSubmit={handleListMembers}>
              <label>
                Friend list ID
                <input
                  type="text"
                  required
                  value={membersGroupId}
                  onChange={(e) => setMembersGroupId(e.target.value)}
                />
              </label>
              <button type="submit" disabled={membersBusy || !membersGroupId}>
                {membersBusy ? "Loading…" : "List members"}
              </button>
            </form>
            {membersError && (
              <p role="alert">Couldn't load members: {membersError}. Please try again.</p>
            )}
            {members && (
              <ul>
                {members.map((m) => (
                  <li key={m.userId}>
                    {displayName(m.userId)} — joined {new Date(m.joinedAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
            {!leaveConfirming ? (
              <button
                type="button"
                onClick={() => setLeaveConfirming(true)}
                disabled={leaveBusy || !membersGroupId}
              >
                Leave
              </button>
            ) : (
              <div role="alertdialog" aria-label="Confirm leaving your friends list">
                <p>Leave your friends list? You'll need a new invite code to reconnect.</p>
                <button type="button" onClick={() => void handleLeaveGroup()} disabled={leaveBusy}>
                  {leaveBusy ? "Leaving…" : "Yes, leave"}
                </button>
                <button
                  type="button"
                  onClick={() => setLeaveConfirming(false)}
                  disabled={leaveBusy}
                >
                  Cancel
                </button>
              </div>
            )}
            {leaveError && (
              <p role="alert">Couldn't leave: {leaveError}. Please try again.</p>
            )}
            {leftGroupId === membersGroupId && !leaveError && (
              <p>You've left your friends list.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
