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

  async function handleLeaveGroup() {
    if (!membersGroupId) return;
    // Minimal confirm per this dispatch's "a button and a confirm, not a new settings page"
    // scope - matches the browser-native confirm this codebase doesn't otherwise use elsewhere,
    // but leaving a group is destructive-ish (loses access to friends' shared data in that group)
    // and irreversible without a fresh invite code, so a bare click felt too easy to mis-fire.
    if (!window.confirm("Leave this group? You'll need a new invite code to rejoin.")) return;
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
            <button
              type="button"
              onClick={() => void handleLeaveGroup()}
              disabled={leaveBusy || !membersGroupId}
            >
              {leaveBusy ? "Leaving…" : "Leave group"}
            </button>
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
