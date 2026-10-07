import { useState } from "react";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import { nudgeMessageText } from "../../domain/accountability/nudgeMessages";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { IncomingProducerTag } from "../../infrastructure/backend/producerTagApi";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import type { IncomingActivity } from "../appFooter/useIncomingActivity";
import { ButtonBool } from "./ui/ButtonBool";
import { ButtonSmall } from "./ui/ButtonSmall";

// The second half of the persistent app-shell footer, stacked beneath StudyRoomFooter.tsx
// inside AppFooter.tsx. All data/handlers are supplied by useIncomingActivity.ts (called once,
// by AppFooter.tsx) as props - this component itself owns no fetches beyond the lazy per-item
// audio download below.

function detailLine(r: FriendRequest, requesterName: string): string {
  if (r.kind === "site_unlock") return `${requesterName} wants to unlock ${r.hostname}`;
  if (r.kind === "site_temp_pass") return `${requesterName} wants a temporary passcode for ${r.hostname}`;
  return `${requesterName} wants to end their session early`;
}

// Every "pick a nudge to send" list elsewhere merges written + audio items into one chronological
// list (StudyRoomFooter.tsx's VaultNudgeItem) - this footer's incoming side does the same,
// treating "an incoming nudge" as one concept regardless of kind.
type IncomingNudgeItem =
  | { kind: "nudge"; sentAt: number; nudge: FriendNudge }
  | { kind: "tag"; sentAt: number; tag: IncomingProducerTag };

// The audio Blob is fetched lazily, only once "Play" is pressed, via
// producerTagApi.downloadTagAudio, called directly rather than through sendMessage - this is a
// Storage-client read, not a plain CRUD backend call.
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
        <ButtonSmall colour="pink" onClick={handlePlay} disabled={loading}>
          {loading ? "Loading…" : "Play Nudge"}
        </ButtonSmall>
      )}
      {error && <p role="alert">{error}</p>}
      <ButtonBool icon="x" aria-label="Dismiss" onClick={onDismiss} />
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
  // Registers with the Header's shared Refresh button instead of rendering its own.
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
  // by itself - that stays AppFooter.tsx's own hasIncomingActivity gate.
  const showNudgeSection = nudgeItems.length > 0 || nudgesError || tagsError;
  const showRequestSection = requests.length > 0 || requestsError;

  return (
    <div className="nudges-and-requests-footer">
      {showNudgeSection && (
        <section className="nudges-and-requests-footer__nudges">
          <h3>Nudges Sent to You</h3>
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
                    <ButtonBool icon="x" aria-label="Dismiss" onClick={() => dismissNudge(item.nudge.id)} />
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
          <h3>Unlock Requests</h3>
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
                  <div className="nudges-and-requests-footer__resolve">
                    <ButtonBool
                      icon="x"
                      aria-label="Deny"
                      onClick={() => resolveRequest(request, "denied")}
                      disabled={resolvingRequestId === request.id}
                    />
                    <ButtonBool
                      icon="check"
                      aria-label="Approve"
                      onClick={() => resolveRequest(request, "approved")}
                      disabled={resolvingRequestId === request.id}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
