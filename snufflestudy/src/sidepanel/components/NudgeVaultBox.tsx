import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import type { ProducerTag } from "../../domain/rooms/producerTag";
import type { NudgeVaultText } from "../../infrastructure/backend/nudgeVaultApi";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { ProducerTagRecorder } from "./ProducerTagRecorder";

// v4.1 Task 9: replaces FriendGroupPanel.tsx's old "Friend activity" panel with the user's own
// Nudge Vault - a library of saved audio and written nudges, reusable across every "pick a nudge
// to send" picker in this codebase (FriendsBox.tsx's bulk Nudge action, StudyRoomFooter.tsx's
// per-selected-participant Nudge action - both via the shared useNudgeVaultItems() hook). This box
// owns its own two SEPARATE lists (audio tags, written texts) rather than that hook's merged view,
// since each half needs its own independent Delete action against its own backend
// (PRODUCER_TAG_DELETE / NUDGE_VAULT_TEXT_DELETE) - see useNudgeVaultItems.ts's own comment on why
// this box doesn't consume it.

// Same lazy-download-on-Play pattern as StudyRoomFooter.tsx's/NudgeSendSection.tsx's identical
// IncomingProducerTagCard - the audio Blob is fetched only once "Play" is pressed, via
// producerTagApi.downloadTagAudio, called DIRECTLY (not through sendMessage - a Storage-client
// read, not a plain CRUD backend call; see that function's own header comment).
function VaultAudioTagRow({
  tag,
  onDelete,
  deleting,
}: {
  tag: ProducerTag;
  onDelete: () => void;
  deleting: boolean;
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
        console.error("Failed to download a saved audio nudge", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  return (
    <li>
      <span>{Math.round(tag.durationMs / 1000)}s clip</span>
      {playbackUrl ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- a short voice tag, not video
        <audio src={playbackUrl} controls autoPlay />
      ) : (
        <button type="button" onClick={handlePlay} disabled={loading}>
          {loading ? "Loading…" : "Play"}
        </button>
      )}
      <button type="button" onClick={onDelete} disabled={deleting}>
        {deleting ? "Deleting…" : "Delete"}
      </button>
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

export function NudgeVaultBox() {
  const [audioTags, setAudioTags] = useState<ProducerTag[] | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [savingAudio, setSavingAudio] = useState(false);
  const [saveAudioError, setSaveAudioError] = useState<string | null>(null);
  const [deletingAudioId, setDeletingAudioId] = useState<string | null>(null);
  const [deleteAudioError, setDeleteAudioError] = useState<string | null>(null);

  const [texts, setTexts] = useState<NudgeVaultText[] | null>(null);
  const [textsError, setTextsError] = useState<string | null>(null);
  const [newText, setNewText] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [saveTextError, setSaveTextError] = useState<string | null>(null);
  const [deletingTextId, setDeletingTextId] = useState<string | null>(null);
  const [deleteTextError, setDeleteTextError] = useState<string | null>(null);

  function loadAudioTags() {
    setAudioError(null);
    sendMessage<{ ok: boolean; tags?: ProducerTag[]; error?: string }>({
      type: "PRODUCER_TAG_LIST_MINE",
    })
      .then((res) => {
        if (!res.ok) {
          setAudioError(res.error ?? "Could not load your saved audio nudges.");
          return;
        }
        setAudioTags(res.tags ?? []);
      })
      .catch((err) => {
        console.error("Failed to load saved audio nudges", err);
        setAudioError(err instanceof Error ? err.message : String(err));
      });
  }

  function loadTexts() {
    setTextsError(null);
    sendMessage<{ ok: boolean; texts?: NudgeVaultText[]; error?: string }>({
      type: "NUDGE_VAULT_TEXT_LIST",
    })
      .then((res) => {
        if (!res.ok) {
          setTextsError(res.error ?? "Could not load your saved written nudges.");
          return;
        }
        setTexts(res.texts ?? []);
      })
      .catch((err) => {
        console.error("Failed to load saved written nudges", err);
        setTextsError(err instanceof Error ? err.message : String(err));
      });
  }

  useEffect(() => {
    loadAudioTags();
    loadTexts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v4.1 Task 2: replaces this box's own Refresh button - the Header's one Refresh button now
  // re-runs both of this box's fetches (among every other currently-mounted panel's own).
  function refreshOwnFetches() {
    loadAudioTags();
    loadTexts();
  }
  useRegisterRefresh(refreshOwnFetches);

  // v4.1 Task 1: recording and saving to the vault IS uploading a producer_tags row - unlike
  // NudgeSendSection.tsx's audio mode (upload then immediately send to a friend), there's no
  // separate "send" step here. blobToBase64 is called directly, not through sendMessage - a pure
  // browser-API helper, not a backend call (producerTagApi.ts's own header comment).
  async function handleRecordAndSave(blob: Blob, durationMs: number) {
    setSavingAudio(true);
    setSaveAudioError(null);
    try {
      const audioBase64 = await producerTagApi.blobToBase64(blob);
      const res = await sendMessage<{ ok: boolean; tag?: ProducerTag; error?: string }>({
        type: "PRODUCER_TAG_UPLOAD",
        payload: { audioBase64, mimeType: blob.type || "audio/webm", durationMs },
      });
      if (!res.ok || !res.tag) {
        throw new Error(res.error ?? "Could not save this recording.");
      }
      loadAudioTags();
    } catch (err) {
      console.error("Failed to save a recorded nudge to the vault", err);
      setSaveAudioError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAudio(false);
    }
  }

  function handleDeleteAudioTag(tagId: string) {
    setDeletingAudioId(tagId);
    setDeleteAudioError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "PRODUCER_TAG_DELETE",
      payload: { tagId },
    })
      .then((res) => {
        if (!res.ok) {
          setDeleteAudioError(res.error ?? "Could not delete this nudge.");
          return;
        }
        setAudioTags((prev) => (prev ? prev.filter((t) => t.id !== tagId) : prev));
      })
      .catch((err) => {
        console.error("Failed to delete a saved audio nudge", err);
        setDeleteAudioError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setDeletingAudioId(null));
  }

  function handleAddText() {
    const trimmed = newText.trim();
    if (!trimmed) return;
    setSavingText(true);
    setSaveTextError(null);
    sendMessage<{ ok: boolean; text?: NudgeVaultText; error?: string }>({
      type: "NUDGE_VAULT_TEXT_CREATE",
      payload: { body: trimmed },
    })
      .then((res) => {
        if (!res.ok || !res.text) {
          setSaveTextError(res.error ?? "Could not save this nudge.");
          return;
        }
        setNewText("");
        loadTexts();
      })
      .catch((err) => {
        console.error("Failed to save a written nudge to the vault", err);
        setSaveTextError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSavingText(false));
  }

  function handleDeleteText(id: string) {
    setDeletingTextId(id);
    setDeleteTextError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "NUDGE_VAULT_TEXT_DELETE",
      payload: { id },
    })
      .then((res) => {
        if (!res.ok) {
          setDeleteTextError(res.error ?? "Could not delete this nudge.");
          return;
        }
        setTexts((prev) => (prev ? prev.filter((t) => t.id !== id) : prev));
      })
      .catch((err) => {
        console.error("Failed to delete a saved written nudge", err);
        setDeleteTextError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setDeletingTextId(null));
  }

  return (
    <div className="nudge-vault-box">
      <h2>Nudge Vault</h2>

      <section className="nudge-vault-box__audio">
        <h3>Audio nudges</h3>
        <ProducerTagRecorder
          onSend={(blob, durationMs) => void handleRecordAndSave(blob, durationMs)}
          sending={savingAudio}
          sendLabel="Save to vault"
        />
        {saveAudioError && <p role="alert">Couldn't save: {saveAudioError}. Please try again.</p>}
        {audioError && <p role="alert">Couldn't load your saved audio nudges: {audioError}.</p>}
        {audioTags === null && !audioError && <p>Loading…</p>}
        {audioTags !== null && audioTags.length === 0 && !audioError && (
          <p>No saved audio nudges yet — record one above.</p>
        )}
        {audioTags !== null && audioTags.length > 0 && (
          <ul>
            {audioTags.map((tag) => (
              <VaultAudioTagRow
                key={tag.id}
                tag={tag}
                onDelete={() => handleDeleteAudioTag(tag.id)}
                deleting={deletingAudioId === tag.id}
              />
            ))}
          </ul>
        )}
        {deleteAudioError && <p role="alert">{deleteAudioError}</p>}
      </section>

      <section className="nudge-vault-box__written">
        <h3>Written nudges</h3>
        <label>
          New nudge
          <input
            type="text"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddText();
              }
            }}
            placeholder="e.g. You've got this!"
            disabled={savingText}
          />
        </label>
        <button type="button" onClick={handleAddText} disabled={savingText || !newText.trim()}>
          {savingText ? "Adding…" : "Add"}
        </button>
        {saveTextError && <p role="alert">Couldn't save: {saveTextError}. Please try again.</p>}
        {textsError && <p role="alert">Couldn't load your saved written nudges: {textsError}.</p>}
        {texts === null && !textsError && <p>Loading…</p>}
        {texts !== null && texts.length === 0 && !textsError && (
          <p>No saved written nudges yet — add one above.</p>
        )}
        {texts !== null && texts.length > 0 && (
          <ul>
            {texts.map((text) => (
              <li key={text.id}>
                <span>{text.body}</span>
                <button
                  type="button"
                  onClick={() => handleDeleteText(text.id)}
                  disabled={deletingTextId === text.id}
                >
                  {deletingTextId === text.id ? "Deleting…" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {deleteTextError && <p role="alert">{deleteTextError}</p>}
      </section>
    </div>
  );
}
