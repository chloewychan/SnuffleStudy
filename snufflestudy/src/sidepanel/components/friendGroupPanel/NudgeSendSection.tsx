import { useState } from "react";
import { sendMessage } from "../../../infrastructure/messaging/extensionMessenger";
import { NUDGE_MESSAGES } from "../../../domain/accountability/nudgeMessages";
import { SignInForm } from "../../../shared/ui/SignInForm";
import { useDisplayNames } from "../../../shared/ui/useDisplayNames";
import * as producerTagApi from "../../../infrastructure/backend/producerTagApi";
import type { IncomingProducerTag } from "../../../infrastructure/backend/producerTagApi";
import type { ProducerTag } from "../../../domain/rooms/producerTag";
import { ProducerTagRecorder } from "../ProducerTagRecorder";

// v3.4 Task 8: one incoming Producer Tag (now presented as an incoming "audio nudge") - a
// friend-sent short recording (room sends never reach this panel; see producerTagApi.ts's
// queryIncomingSince comment). Carried over verbatim from today's ProducerTagSection.tsx (the
// audio Blob is fetched lazily, only once "Play" is pressed, via producerTagApi.downloadTagAudio -
// called DIRECTLY, not through sendMessage, per that file's own header comment).
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

interface NudgeSendSectionProps {
  // Friend-picker props, identical to today's NudgeSendForm.tsx (unchanged by Task 2's
  // friendshipApi.ts rewrite - useFriendGroupPanelData.ts still returns the same friendIds/
  // selfUserId/friendsError/friendsLoading shape, just sourced differently underneath).
  friendsLoading: boolean;
  friendsError: string | null;
  friendIds: string[] | null;
  selfUserId: string | null;
  effectiveFriendId: string;
  onSelectFriend: (friendId: string) => void;
  onFriendsReload: () => void;
  // Carried over from today's ProducerTagSection.tsx props.
  incomingTags: IncomingProducerTag[] | null;
  tagsError: string | null;
}

type NudgeMode = "written" | "audio";

// v3.4 Task 8: merges today's NudgeSendForm.tsx (friend picker + predefined-message catalog,
// server-gated by can_send_nudge() - see
// supabase/migrations/20260815000044_v3.4_nudge_cooldowns_and_producer_tag_rate_limit.sql) and
// ProducerTagSection.tsx (record/upload/send-to-friend flow, now ALSO server-gated by the new
// can_send_producer_tag_dm(), same migration) into one "Send a nudge" section with a Written/
// Audio toggle. One friend picker total, shared by both modes - not two separate pickers. See
// that migration's header comment and docs/reports/v3.4/task-8-report.md for why the two
// cooldowns are independent even though both modes share the same on/off toggle
// (receiveLiveNudges/sendLiveNudges).
export function NudgeSendSection({
  friendsLoading,
  friendsError,
  friendIds,
  selfUserId,
  effectiveFriendId,
  onSelectFriend,
  onFriendsReload,
  incomingTags,
  tagsError,
}: NudgeSendSectionProps) {
  const [mode, setMode] = useState<NudgeMode>("written");

  // --- Written mode state/logic, carried over verbatim from today's NudgeSendForm.tsx ---
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
          // supabase/migrations/20260815000044_v3.4_nudge_cooldowns_and_producer_tag_rate_limit.sql's
          // can_send_nudge()) - surfaced inline, never silently swallowed.
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

  // --- Audio mode state/logic, carried over verbatim from today's ProducerTagSection.tsx ---
  const [tagSendBusy, setTagSendBusy] = useState(false);
  const [tagSendError, setTagSendError] = useState<string | null>(null);
  const [tagSendSuccess, setTagSendSuccess] = useState<string | null>(null);

  // v2 Task 14: record -> upload -> send-to-friend, in one call from ProducerTagRecorder's onSend.
  // Reuses the SAME target-friend selection as written nudges (effectiveFriendId, passed down from
  // the FriendGroupPanel container) rather than a second, independent friend picker.
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
          <div className="friend-group-panel__nudge-mode-toggle">
            <button type="button" onClick={() => setMode("written")} aria-pressed={mode === "written"}>
              Written
            </button>
            <button type="button" onClick={() => setMode("audio")} aria-pressed={mode === "audio"}>
              Audio
            </button>
          </div>
          {mode === "written" && (
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
          )}
          {sendError && <p role="alert">Nudge not sent: {sendError}</p>}
          {sendSuccess && <p>{sendSuccess}</p>}
          {mode === "audio" && (
            <ProducerTagRecorder
              onSend={handleSendProducerTag}
              sending={tagSendBusy}
              sendLabel={effectiveFriendId ? `Send to friend ${effectiveFriendId}` : "Send"}
              sendDisabled={!effectiveFriendId}
            />
          )}
          {tagSendError && <p role="alert">Tag not sent: {tagSendError}</p>}
          {tagSendSuccess && <p>{tagSendSuccess}</p>}
        </>
      )}

      {/* Incoming-tags list, carried over unchanged from today's ProducerTagSection.tsx - kept in
          this merged component rather than split elsewhere, since it's part of the same "audio
          nudge" concept now. Rendered unconditionally (not gated on mode or on having a friend
          selected), same as before. */}
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
