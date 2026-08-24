import type { DigestSummary } from "../../../infrastructure/backend/digestApi";
import { SignInForm } from "../../../shared/ui/SignInForm";

// v2 Task 9: renders one friend's digest summary in approachable copy (not raw field names) -
// per that task's brief ("Bob was really locked in today"). No display-name source exists
// anywhere in this codebase yet (same limitation FriendGroupPanel's event list and
// friendGroupApi.ts's listMembers() already have - no `profiles` table), so the friend is
// identified by their raw user id, consistent with how this panel already renders friend ids
// elsewhere.
function DigestCard({ digest }: { digest: DigestSummary }) {
  const recoveryPercent = Math.round(digest.recoveryRate * 100);
  return (
    <li>
      <strong>Friend {digest.friendUserId}</strong> was really locked in today —{" "}
      {digest.completedSessions} session{digest.completedSessions === 1 ? "" : "s"} completed,{" "}
      {digest.abandonedSessions} abandoned, {digest.distractionCount} distraction
      {digest.distractionCount === 1 ? "" : "s"}, {recoveryPercent}% recovered.
    </li>
  );
}

interface DigestSectionProps {
  digestsError: string | null;
  // Already filtered to exclude the caller's own row - see useFriendGroupPanelData's own
  // comment (digestApi.fetchDigestForDate deliberately does NOT filter it out itself).
  friendDigests: DigestSummary[] | null;
  // Used only as the "is self-identity known yet" guard below - see the inline comment at its
  // use site.
  friendIds: string[] | null;
  selfUserId: string | null;
  onReload: () => void;
}

export function DigestSection({
  digestsError,
  friendDigests,
  friendIds,
  selfUserId,
  onReload,
}: DigestSectionProps) {
  return (
    <section className="friend-group-panel__digest">
      <h3>Daily digest</h3>
      {digestsError && (
        <p role="alert">Couldn't load the daily digest: {digestsError}. Please try again.</p>
      )}
      {/* v3.2 Task 2: gated on `friendIds !== null` too (not just selfUserId === null) for the
          same reason as NudgeSendForm's guard - loadDigests() runs independently of
          loadFriends(), so digests can resolve to [] before loadFriends() has ever set
          selfUserId. Waiting for friendIds to be known avoids showing this prompt to a
          signed-in user whose own self-identity fetch just hasn't resolved yet. */}
      {friendDigests && friendDigests.length === 0 && !digestsError && (
        friendIds !== null && selfUserId === null ? (
          <div className="friend-group-panel__sign-in">
            <p>Sign in to see your friends' daily digest.</p>
            <SignInForm onSignedIn={() => onReload()} />
          </div>
        ) : (
          <p>No digest yet for yesterday — check back once a friend has completed a session.</p>
        )
      )}
      {friendDigests && friendDigests.length > 0 && (
        <ul className="friend-group-panel__digests">
          {friendDigests.map((digest) => (
            <DigestCard key={digest.friendUserId} digest={digest} />
          ))}
        </ul>
      )}
    </section>
  );
}
