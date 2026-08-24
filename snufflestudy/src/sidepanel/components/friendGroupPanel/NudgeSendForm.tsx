import { useState } from "react";
import { sendMessage } from "../../../infrastructure/messaging/extensionMessenger";
import { NUDGE_MESSAGES } from "../../../domain/accountability/nudgeMessages";
import { SignInForm } from "../../../shared/ui/SignInForm";
import { useDisplayNames } from "../../../shared/ui/useDisplayNames";

interface NudgeSendFormProps {
  friendsLoading: boolean;
  friendsError: string | null;
  friendIds: string[] | null;
  selfUserId: string | null;
  // Owned by the FriendGroupPanel container, not this component - see that file's own comment
  // for why (shared with ProducerTagSection's send target).
  effectiveFriendId: string;
  onSelectFriend: (friendId: string) => void;
  // Re-runs useFriendGroupPanelData's loadFriends() after a successful inline sign-in, so the
  // picker actually populates with the now-known friend list instead of staying on the just-
  // dismissed sign-in prompt.
  onFriendsReload: () => void;
}

// v2 Task 7 additions (moved into its own file, v3.2 Task 7 split - no behavior change): a
// nudge-send picker (target friend + predefined message catalog, gated server-side per nudges'
// RLS - see supabase/migrations/20260815000007_v2_nudges.sql) - follows FriendGroupPanel's
// existing message-passing-only convention (sendMessage, no direct infrastructure/backend
// imports beyond types).
export function NudgeSendForm({
  friendsLoading,
  friendsError,
  friendIds,
  selfUserId,
  effectiveFriendId,
  onSelectFriend,
  onFriendsReload,
}: NudgeSendFormProps) {
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  // v3.3 Task 8: resolves each friend id to their human_name (falling back to the raw id, same as
  // before this task, when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(friendIds ?? []);

  function handleSendNudge(friendId: string, messageId: string) {
    if (!friendId) return;
    setSendBusy(true);
    setSendError(null);
    setSendSuccess(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "NUDGE_SEND",
      payload: { friendUserId: friendId, messageId },
    })
      .then((res) => {
        if (!res.ok) {
          // Server-side rejection (toggle off or cooldown active - see
          // supabase/migrations/20260815000007_v2_nudges.sql's can_send_nudge()) - surfaced
          // inline, never silently swallowed.
          setSendError(res.error ?? "Could not send that nudge.");
          return;
        }
        setSendSuccess("Nudge sent.");
      })
      .catch((err) => {
        console.error("Failed to send nudge", err);
        setSendError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSendBusy(false));
  }

  return (
    <section className="friend-group-panel__nudge-send">
      <h3>Send a nudge</h3>
      {friendsLoading && !friendIds && <p>Loading friends…</p>}
      {friendsError && (
        <p role="alert">Couldn't load friends: {friendsError}. Please try again.</p>
      )}
      {/* v3.2 Task 2: `friendIds && ...` (rather than a bare `selfUserId === null` check) is
          the "is self-identity actually known yet" guard here - the hook's loadFriends() sets
          selfUserId synchronously before it ever sets friendIds, so by the time friendIds is
          non-null, selfUserId reflects the real, resolved sign-in state, not just its unset
          initial value. This avoids a signed-in user (whose friendIds fetch is still in flight)
          transiently seeing a sign-in prompt before flipping to their real friend list. */}
      {friendIds && friendIds.length === 0 && !friendsError && (
        selfUserId === null ? (
          <div className="friend-group-panel__sign-in">
            <p>Sign in to nudge friends.</p>
            <SignInForm onSignedIn={() => onFriendsReload()} />
          </div>
        ) : (
          <p>No friends to nudge yet — add a friend first.</p>
        )
      )}
      {friendIds && friendIds.length > 0 && (
        <>
          <label>
            Friend
            <select
              value={effectiveFriendId}
              onChange={(e) => onSelectFriend(e.target.value)}
            >
              {friendIds.map((id) => (
                <option key={id} value={id}>
                  {displayName(id)}
                </option>
              ))}
            </select>
          </label>
          <div className="friend-group-panel__nudge-messages">
            {NUDGE_MESSAGES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => handleSendNudge(effectiveFriendId, m.id)}
                disabled={sendBusy || !effectiveFriendId}
              >
                {m.text}
              </button>
            ))}
          </div>
          {sendError && <p role="alert">Nudge not sent: {sendError}</p>}
          {sendSuccess && <p>{sendSuccess}</p>}
        </>
      )}
    </section>
  );
}
