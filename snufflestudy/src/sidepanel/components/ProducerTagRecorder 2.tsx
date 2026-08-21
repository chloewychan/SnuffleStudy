import { useRef, useState } from "react";
import * as audioRecorder from "../../infrastructure/audio/audioRecorder";

interface ProducerTagRecorderProps {
  onSend: (blob: Blob, durationMs: number) => void;
  sending: boolean;
  sendLabel: string;
  sendDisabled?: boolean;
}

// v2 Task 14: the shared record -> preview -> send widget used by both FriendGroupPanel.tsx and
// StudyRoomPanel.tsx (per this task's brief: "Minimal recording/playback UI... in both"). Factored
// out into its own small component rather than duplicated twice - the record/preview/countdown
// mechanics are identical in both places; only the send TARGET (a specific friend vs. the current
// room) and what happens to already-received tags differ, which stays local to each panel per the
// brief's own "self-contained, clearly-scoped addition to each" guidance (matching FriendGroupPanel's
// own DigestCard/IncomingNudgeCard precedent for a small, focused sub-component) - this component
// owns none of the send-target or received-tag logic, only recording itself.
//
// The visual max-length enforcement (a live countdown, and auto-stopping the instant the cap is
// hit rather than waiting for a manual "Stop" click) is ON TOP OF, not instead of,
// audioRecorder.ts's own internal enforcement (see that module's header comment) - this
// component's countdown/auto-stop threshold is read directly from audioRecorder.MAX_RECORDING_MS
// so the two can never drift out of sync with each other.
export function ProducerTagRecorder({ onSend, sending, sendLabel, sendDisabled }: ProducerTagRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
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
      setRecordError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecording(false);
    }
  }

  function handleStart() {
    setRecordError(null);
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
        <button type="button" onClick={handleStart}>
          Record a tag ({capSeconds}s max)
        </button>
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

      {recordError && <p role="alert">Could not record: {recordError}</p>}
    </div>
  );
}
