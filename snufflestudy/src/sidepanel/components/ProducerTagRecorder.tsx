import { useRef, useState } from "react";
import * as audioRecorder from "../../infrastructure/audio/audioRecorder";
import {
  MEDIA_PERMISSION_HELP_MESSAGE,
  isMediaPermissionError,
  openMediaPermissionTab,
} from "../../infrastructure/media/mediaPermissions";
import ButtonLarge from "../ui/ButtonLarge";
import styles from "./ProducerTagRecorder.module.css";

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
  // QA-discovered bug (v3.2 Task 9): getUserMedia() rejects with a real but genuinely confusing
  // browser message ("Permission dismissed") when this panel can't show the permission prompt at
  // all (a Chrome side-panel limitation, not a per-user mistake - see mediaPermissions.ts).
  // Replaced with our own clear message + an actual fix action, instead of passing the raw
  // browser text straight through.
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

  // v4.2 Task 10: re-skinned to match NudgeVaultPanel.tsx's visual language (ButtonLarge for every
  // action, this file's own new ProducerTagRecorder.module.css for layout - see that file's header
  // comment on why it's originated rather than transplanted). The state machine itself (what
  // triggers recording start/stop, preview playback, discard, send) is untouched below - only the
  // JSX/CSS changed. Every literal button/status string is preserved exactly as before, so
  // ProducerTagRecorder.test.tsx's text-based queries still resolve the same content; two of its
  // toBeDisabled() assertions were updated from getByText(...) to getByRole("button", {name:...})
  // since ButtonLarge now nests that text inside its own <h3> (toBeDisabled() only recognizes bona
  // fide form controls) - same behavior verified, just queried via the actual <button> now.
  return (
    <div className={styles.recorder}>
      {!recording && !preview && (
        <ButtonLarge button={`Record a tag (${capSeconds}s max)`} onClick={handleStart} />
      )}

      {recording && (
        <div className={styles.recordingRow}>
          <span role="status" className={styles.status}>
            Recording… {elapsedSeconds}s / {capSeconds}s
          </span>
          <ButtonLarge button="Stop" onClick={() => void finishRecording()} />
        </div>
      )}

      {preview && (
        <div className={styles.previewRow}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a short voice tag, not video */}
          <audio src={preview.url} controls />
          <ButtonLarge
            button={sending ? "Sending…" : sendLabel}
            onClick={() => onSend(preview.blob, preview.durationMs)}
            disabled={sending || sendDisabled}
          />
          <ButtonLarge button="Discard" onClick={handleDiscard} disabled={sending} />
        </div>
      )}

      {recordError && (
        <p role="alert">
          Could not record: {recordError}
          {recordErrorActionable && (
            <>
              {" "}
              <ButtonLarge button="Open a tab to grant access" onClick={openMediaPermissionTab} />
            </>
          )}
        </p>
      )}
    </div>
  );
}
