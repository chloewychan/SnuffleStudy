import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type {
  FriendGroup,
  GroupMembership,
  InviteCode,
} from "../../infrastructure/backend/friendGroupApi";
import { SignInForm, type SignInFormSession } from "../../shared/ui/SignInForm";

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

  const [groupName, setGroupName] = useState("");
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
    } catch (err) {
      console.error("Failed to sign out", err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
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
    } catch (err) {
      console.error("Failed to delete account", err);
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    setGroupBusy(true);
    setGroupError(null);
    try {
      const res = await sendMessage<{ ok: boolean; group?: FriendGroup; error?: string }>({
        type: "GROUP_CREATE",
        payload: { name: groupName },
      });
      if (!res.ok || !res.group) {
        setGroupError(res.error ?? "Could not create the group.");
        return;
      }
      setGroup(res.group);
      setMembersGroupId(res.group.id);
      setInviteCode(null);
      setGroupName("");
    } catch (err) {
      console.error("Failed to create group", err);
      setGroupError(err instanceof Error ? err.message : String(err));
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleGenerateInvite() {
    if (!group) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await sendMessage<{ ok: boolean; inviteCode?: InviteCode; error?: string }>({
        type: "GROUP_GENERATE_INVITE_CODE",
        payload: { groupId: group.id },
      });
      if (!res.ok || !res.inviteCode) {
        setInviteError(res.error ?? "Could not generate an invite code.");
        return;
      }
      setInviteCode(res.inviteCode);
    } catch (err) {
      console.error("Failed to generate invite code", err);
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
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
        setLeaveError(res.error ?? "Could not leave the group.");
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
            <h3>Delete account</h3>
            <p>
              Permanently deletes your account and every record tied to it across SnuffleStudy's
              servers - friend groups, study rooms, Producer Tags, digests, nudges, and everything
              else. This cannot be undone. See the Privacy page for the full list of what's stored
              and where.
            </p>
            {!deleteConfirming ? (
              <button type="button" onClick={() => setDeleteConfirming(true)} disabled={deleteBusy}>
                Delete account
              </button>
            ) : (
              <div role="alertdialog" aria-label="Confirm account deletion">
                <p>
                  <strong>Are you sure?</strong> This removes your friend groups (or hands them
                  off to another member), study room history, Producer Tags, digests, and every
                  other record tied to your account, everywhere. This cannot be undone.
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
            <h3>Create a friend group</h3>
            <form onSubmit={handleCreateGroup}>
              <label>
                Group name
                <input
                  type="text"
                  required
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </label>
              <button type="submit" disabled={groupBusy || !groupName}>
                {groupBusy ? "Creating…" : "Create group"}
              </button>
            </form>
            {groupError && (
              <p role="alert">Couldn't create the group: {groupError}. Please try again.</p>
            )}
            {group && (
              <div>
                <p>
                  Created "{group.name}" ({group.id}).
                </p>
                <button type="button" onClick={() => void handleGenerateInvite()} disabled={inviteBusy}>
                  {inviteBusy ? "Generating…" : "Generate invite code"}
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
              </div>
            )}
          </section>

          <section>
            <h3>Join a friend group</h3>
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
                {joinBusy ? "Joining…" : "Join group"}
              </button>
            </form>
            {joinError && (
              <p role="alert">Couldn't join the group: {joinError}. Please try again.</p>
            )}
          </section>

          <section>
            <h3>Group members</h3>
            <form onSubmit={handleListMembers}>
              <label>
                Group ID
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
                    {m.userId} — joined {new Date(m.joinedAt).toLocaleString()}
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
                Leave group
              </button>
            ) : (
              <div role="alertdialog" aria-label="Confirm leaving the group">
                <p>Leave this group? You'll need a new invite code to rejoin.</p>
                <button type="button" onClick={() => void handleLeaveGroup()} disabled={leaveBusy}>
                  {leaveBusy ? "Leaving…" : "Yes, leave group"}
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
              <p role="alert">Couldn't leave the group: {leaveError}. Please try again.</p>
            )}
            {leftGroupId === membersGroupId && !leaveError && (
              <p>You've left this group.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
