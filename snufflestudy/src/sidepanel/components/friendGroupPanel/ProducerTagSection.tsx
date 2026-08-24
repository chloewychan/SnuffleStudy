import { useState } from "react";
import { sendMessage } from "../../../infrastructure/messaging/extensionMessenger";
import * as producerTagApi from "../../../infrastructure/backend/producerTagApi";
import type { IncomingProducerTag } from "../../../infrastructure/backend/producerTagApi";
import type { ProducerTag } from "../../../domain/rooms/producerTag";
import { ProducerTagRecorder } from "../ProducerTagRecorder";

// v2 Task 14: one incoming Producer Tag - a friend-sent short recording (room sends never reach
// this panel; see producerTagApi.ts's queryIncomingSince comment). The audio Blob is fetched
// lazily (only once "Play" is pressed, not eagerly for every tag the moment the list loads) via
// producerTagApi.downloadTagAudio - called DIRECTLY (not through sendMessage), per that file's own
// header comment: the resulting Blob needs to feed straight into this component's own <audio>
// element/URL.createObjectURL, and can't cross the sendMessage boundary under this codebase's
// current message serialization anyway.
function IncomingProducerTagCard({ tag }: { tag: IncomingProducerTag }) {
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
        From friend {tag.senderUserId} — {Math.round(tag.durationMs / 1000)}s
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
    </li>
  );
}

interface ProducerTagSectionProps {
  // Owned by the FriendGroupPanel container - shared with NudgeSendForm's send target. See that
  // file's own comment for why.
  effectiveFriendId: string;
  incomingTags: IncomingProducerTag[] | null;
  tagsError: string | null;
}

export function ProducerTagSection({
  effectiveFriendId,
  incomingTags,
  tagsError,
}: ProducerTagSectionProps) {
  const [tagSendBusy, setTagSendBusy] = useState(false);
  const [tagSendError, setTagSendError] = useState<string | null>(null);
  const [tagSendSuccess, setTagSendSuccess] = useState<string | null>(null);

  // v2 Task 14: record -> upload -> send-to-friend, in one call from ProducerTagRecorder's onSend.
  // Reuses the SAME target-friend selection as "Send a nudge" (effectiveFriendId, passed down from
  // the FriendGroupPanel container) rather than a second, independent friend picker - both
  // features target "a friend from one of my groups", and this panel already has exactly one such
  // picker; a second one would just be duplicated UI for the same underlying choice.
  //
  // uploadTag/sendToFriend both go through messageRouter.ts (PRODUCER_TAG_UPLOAD then
  // PRODUCER_TAG_SEND_TO_FRIEND) - see producerTagApi.ts's header comment for why these two, and
  // not the record/playback steps around them, are message-routed. blobToBase64 is called
  // directly (a pure browser-API helper, not a backend call - see that function's own comment).
  async function handleSendProducerTag(blob: Blob, durationMs: number) {
    if (!effectiveFriendId) return;
    setTagSendBusy(true);
    setTagSendError(null);
    setTagSendSuccess(null);
    try {
      const audioBase64 = await producerTagApi.blobToBase64(blob);
      const uploadRes = await sendMessage<{ ok: boolean; tag?: ProducerTag; error?: string }>({
        type: "PRODUCER_TAG_UPLOAD",
        payload: { audioBase64, mimeType: blob.type || "audio/webm", durationMs },
      });
      if (!uploadRes.ok || !uploadRes.tag) {
        throw new Error(uploadRes.error ?? "Could not upload this recording.");
      }

      const sendRes = await sendMessage<{ ok: boolean; error?: string }>({
        type: "PRODUCER_TAG_SEND_TO_FRIEND",
        payload: { tagId: uploadRes.tag.id, friendUserId: effectiveFriendId },
      });
      if (!sendRes.ok) {
        throw new Error(sendRes.error ?? "Could not send this tag.");
      }
      setTagSendSuccess("Tag sent.");
    } catch (err) {
      console.error("Failed to send producer tag", err);
      setTagSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setTagSendBusy(false);
    }
  }

  return (
    <section className="friend-group-panel__producer-tags">
      <h3>Producer tags</h3>
      <ProducerTagRecorder
        onSend={handleSendProducerTag}
        sending={tagSendBusy}
        sendLabel={effectiveFriendId ? `Send to friend ${effectiveFriendId}` : "Send"}
        sendDisabled={!effectiveFriendId}
      />
      {tagSendError && <p role="alert">Tag not sent: {tagSendError}</p>}
      {tagSendSuccess && <p>{tagSendSuccess}</p>}

      {tagsError && (
        <p role="alert">Couldn't load producer tags: {tagsError}. Please try again.</p>
      )}
      {incomingTags && incomingTags.length === 0 && !tagsError && <p>No producer tags yet.</p>}
      {incomingTags && incomingTags.length > 0 && (
        <ul className="friend-group-panel__producer-tag-list">
          {incomingTags.map((tag) => (
            <IncomingProducerTagCard key={`${tag.tagId}-${tag.sentAt}`} tag={tag} />
          ))}
        </ul>
      )}
    </section>
  );
}
