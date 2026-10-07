import { useRef, useState } from "react";
import * as audioRecorder from "../../infrastructure/audio/audioRecorder";
import {
  MEDIA_PERMISSION_HELP_MESSAGE,
  isMediaPermissionError,
  openMediaPermissionTab,
} from "../../infrastructure/media/mediaPermissions";
import { ButtonLarge } from "./ui/ButtonLarge";

interface ProducerTagRecorderProps {
  onSend: (blob: Blob, durationMs: number) => void;
  sending: boolean;
  sendLabel: string;
  sendDisabled?: boolean;
  // Overrides the generic "Record a tag" button copy for callers that need different wording.
  idleLabel?: string;
}

// A shared record -> preview -> send widget. It only owns the recording/preview/countdown
// mechanics; the send target and what happens to already-received tags stay with each caller.
//
// The visible countdown and its auto-stop are on top of, not instead of, audioRecorder.ts's own
// internal max-length enforcement. The threshold here is read directly from
// audioRecorder.MAX_RECORDING_MS so the two can never drift out of sync with each other.
export function ProducerTagRecorder({
  onSend,
  sending,
  sendLabel,
  sendDisabled,
  idleLabel,
}: ProducerTagRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  // getUserMedia() rejects with a confusing browser message ("Permission dismissed") when a
  // Chrome side-panel limitation prevents showing the permission prompt at all (see
  // mediaPermissions.ts) - not a per-user mistake. We show our own clear message with an actual
  // fix action instead of passing the raw browser text through.
  const [recordErrorActionable, setRecordErrorActionable] = useState(false);
  const [preview, setPreview] = useState<{ blob: Blob; url: string; durationMs: number } | null>(null);

  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  function clearTick() {
    if (tickTimer.current) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
  }

  async function finishRecording() {
    clearTick();
    try {
      const blob = await audioRecorder.stopRecording();
      const durationMs = audioRecorder.getLastRecordingDurationMs() ?? elapsedMs;
      setPreview({ blob, url: URL.createObjectURL(blob), durationMs });
    } catch (err) {
      console.error("Failed to stop recording", err);
      setRecordError(
        isMediaPermissionError(err)
          ? MEDIA_PERMISSION_HELP_MESSAGE
          : err instanceof Error
            ? err.message
            : String(err)
      );
      setRecordErrorActionable(isMediaPermissionError(err));
    } finally {
      setRecording(false);
    }
  }

  function handleStart() {
    setRecordError(null);
    setRecordErrorActionable(false);
    if (preview) {
      URL.revokeObjectURL(preview.url);
      setPreview(null);
    }
    audioRecorder.startRecording();
    setRecording(true);
    setElapsedMs(0);
    startedAtRef.current = Date.now();
    // Ticks the visible countdown, and auto-transitions to the preview step the instant the cap
    // is hit - matching (not replacing) audioRecorder.ts's own internal auto-stop, which has
    // already actually stopped capturing audio by this same moment regardless of whether this UI
    // timer notices promptly.
    tickTimer.current = setInterval(() => {
      const elapsed = Math.min(Date.now() - startedAtRef.current, audioRecorder.MAX_RECORDING_MS);
      setElapsedMs(elapsed);
      if (elapsed >= audioRecorder.MAX_RECORDING_MS) {
        void finishRecording();
      }
    }, 100);
  }

  function handleDiscard() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  const capSeconds = Math.round(audioRecorder.MAX_RECORDING_MS / 1000);
  const elapsedSeconds = Math.min(Math.floor(elapsedMs / 1000), capSeconds);

  return (
    <div className="producer-tag-recorder">
      {!recording && !preview && (
        <ButtonLarge onClick={handleStart}>
          {idleLabel ?? `Record a tag (${capSeconds}s max)`}
        </ButtonLarge>
      )}

      {recording && (
        <div className="producer-tag-recorder__recording">
          <span role="status">
            Recording… {elapsedSeconds}s / {capSeconds}s
          </span>
          <button type="button" onClick={() => void finishRecording()}>
            Stop
          </button>
        </div>
      )}

      {preview && (
        <div className="producer-tag-recorder__preview">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a short voice tag, not video */}
          <audio src={preview.url} controls />
          <button
            type="button"
            onClick={() => onSend(preview.blob, preview.durationMs)}
            disabled={sending || sendDisabled}
          >
            {sending ? "Sending…" : sendLabel}
          </button>
          <button type="button" onClick={handleDiscard} disabled={sending}>
            Discard
          </button>
        </div>
      )}

      {recordError && (
        <p role="alert">
          Could not record: {recordError}
          {recordErrorActionable && (
            <>
              {" "}
              <button type="button" onClick={openMediaPermissionTab}>
                Open a tab to grant access
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
