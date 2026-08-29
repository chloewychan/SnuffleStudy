import { useState } from "react";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import { nudgeMessageText } from "../../domain/accountability/nudgeMessages";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { IncomingProducerTag } from "../../infrastructure/backend/producerTagApi";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import type { IncomingActivity } from "../appFooter/useIncomingActivity";

// v4.1 Task 8: the second half of the persistent app-shell footer (stacked beneath
// StudyRoomFooter.tsx inside AppFooter.tsx - see that file). Relocates logic that already worked -
// FriendGroupPanel.tsx's incoming-nudge/incoming-audio-tag display+dismiss and the old standalone
// approver-side panel's request list+resolve - into one always-mounted presentation, per the
// scope doc's "Nudges & Unlock Requests footer" section. All data/handlers are supplied by
// useIncomingActivity.ts (called once, by AppFooter.tsx) as props - this component itself owns no
// fetches of its own beyond the lazy per-item audio download below.

// Moved verbatim from the old standalone approver-side friend-requests panel.
function detailLine(r: FriendRequest, requesterName: string): string {
  if (r.kind === "site_unlock") return `${requesterName} wants to unlock ${r.hostname}`;
  if (r.kind === "site_temp_pass") return `${requesterName} wants a temporary passcode for ${r.hostname}`;
  return `${requesterName} wants to end their session early`;
}

// Every "pick a nudge to send" list elsewhere merges written + audio items into one chronological
// list (StudyRoomFooter.tsx's VaultNudgeItem) - this footer's INCOMING side does the same, since
// the scope doc's own footer spec treats "an incoming nudge" as one concept regardless of kind
// ("the sender, its content (an audio player or the written text), and a Dismiss button").
type IncomingNudgeItem =
  | { kind: "nudge"; sentAt: number; nudge: FriendNudge }
  | { kind: "tag"; sentAt: number; tag: IncomingProducerTag };

// Carried over from friendGroupPanel/NudgeSendSection.tsx's IncomingProducerTagCard - the audio
// Blob is fetched lazily, only once "Play" is pressed, via producerTagApi.downloadTagAudio, called
// DIRECTLY (not through sendMessage - see that file's own header comment for why).
function IncomingTagRow({
  tag,
  senderLabel,
  onDismiss,
}: {
  tag: IncomingProducerTag;
  senderLabel: string;
  onDismiss: () => void;
}) {
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handlePlay() {
    setLoading(true);
    setError(null);
    producerTagApi
      .downloadTagAudio(tag.audioUrl)
      .then((blob) => setPlaybackUrl(URL.createObjectURL(blob)))
      .catch((err) => {
        console.error("Failed to download producer tag audio", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  return (
    <li>
      <span>
        {senderLabel} sent you a {Math.round(tag.durationMs / 1000)}s audio nudge.
      </span>
      {playbackUrl ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- a short voice tag, not video
        <audio src={playbackUrl} controls autoPlay />
      ) : (
        <button type="button" onClick={handlePlay} disabled={loading}>
          {loading ? "Loading…" : "Play"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </li>
  );
}

export function NudgesAndRequestsFooter({
  nudges,
  nudgesError,
  incomingTags,
  tagsError,
  requests,
  requestsError,
  resolvingRequestId,
  resolveError,
  dismissNudge,
  dismissTag,
  resolveRequest,
  refresh,
}: IncomingActivity) {
  // v4.1 Task 2: replaces this content's old separate Refresh buttons (the standalone
  // approver-side panel's own, plus FriendGroupPanel's "Refresh" which used to also cover
  // nudges/tags) with the Header's one button.
  useRegisterRefresh(refresh);

  const displayName = useDisplayNames([
    ...nudges.map((n) => n.senderUserId),
    ...incomingTags.map((t) => t.senderUserId),
    ...requests.map((r) => r.requesterUserId),
  ]);

  const nudgeItems: IncomingNudgeItem[] = [
    ...nudges.map((nudge) => ({ kind: "nudge" as const, sentAt: nudge.sentAt, nudge })),
    ...incomingTags.map((tag) => ({ kind: "tag" as const, sentAt: tag.sentAt, tag })),
  ].sort((a, b) => a.sentAt - b.sentAt);

  // Each section only mounts once it has something to show OR its own fetch failed - so an error
  // is never silently dropped once the footer is already visible for some other reason, but a
  // fetch failure alone (with genuinely nothing pending) doesn't force the whole footer into view
  // by itself - that stays AppFooter.tsx's own hasIncomingActivity gate (Decision 5/Task 7).
  const showNudgeSection = nudgeItems.length > 0 || nudgesError || tagsError;
  const showRequestSection = requests.length > 0 || requestsError;

  return (
    <div className="nudges-and-requests-footer">
      {showNudgeSection && (
        <section className="nudges-and-requests-footer__nudges">
          <h3>Nudges</h3>
          {nudgesError && <p role="alert">Couldn't load incoming nudges: {nudgesError}.</p>}
          {tagsError && <p role="alert">Couldn't load incoming audio nudges: {tagsError}.</p>}
          {nudgeItems.length > 0 && (
            <ul>
              {nudgeItems.map((item) =>
                item.kind === "nudge" ? (
                  <li key={`nudge-${item.nudge.id}`}>
                    <span>
                      {displayName(item.nudge.senderUserId)}:{" "}
                      {item.nudge.customBody ??
                        (item.nudge.messageId ? nudgeMessageText(item.nudge.messageId) : null) ??
                        "sent you a nudge."}
                    </span>
                    <button type="button" onClick={() => dismissNudge(item.nudge.id)}>
                      Dismiss
                    </button>
                  </li>
                ) : (
                  <IncomingTagRow
                    key={`tag-${item.tag.tagId}-${item.tag.sentAt}`}
                    tag={item.tag}
                    senderLabel={displayName(item.tag.senderUserId)}
                    onDismiss={() => dismissTag(item.tag)}
                  />
                )
              )}
            </ul>
          )}
        </section>
      )}

      {showRequestSection && (
        <section className="nudges-and-requests-footer__requests">
          <h3>Friend requests</h3>
          {requestsError && <p role="alert">Couldn't load friend requests: {requestsError}.</p>}
          {resolveError && <p role="alert">{resolveError}</p>}
          {requests.length > 0 && (
            <ul>
              {requests.map((request) => (
                <li key={request.id}>
                  <span>{detailLine(request, displayName(request.requesterUserId))}</span>
                  {request.message && (
                    <p className="nudges-and-requests-footer__message">"{request.message}"</p>
                  )}
                  <button
                    type="button"
                    aria-label="Deny"
                    onClick={() => resolveRequest(request, "denied")}
                    disabled={resolvingRequestId === request.id}
                  >
                    ✕
                  </button>
                  <button
                    type="button"
                    aria-label="Approve"
                    onClick={() => resolveRequest(request, "approved")}
                    disabled={resolvingRequestId === request.id}
                  >
                    ✓
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
