// v2 Task 14: Producer Tags - MediaRecorder-based short-clip audio recording.
//
// MUST be called from the sidepanel's real DOM page context, not a content script or the
// background service worker. navigator.mediaDevices.getUserMedia is a real, user-facing browser
// permission prompt, entirely separate from any chrome.permissions/manifest permission - no
// "microphone" (or any media) entry exists anywhere in wxt.config.ts's manifest.permissions or
// optional_host_permissions, and none is needed for this API. This module needs a genuine page
// context for two independent reasons, mirroring videoCallClient.ts's own identical constraint for
// camera access (see that file's header comment):
//   1. getUserMedia does not exist at all on an MV3 background service worker's global scope (no
//      `navigator.mediaDevices` there) - not a permissions question, a missing-API question.
//   2. A content script runs inside an arbitrary third-party host page's own frame, subject to
//      that page's Permissions-Policy header (which this extension does not control) - `microphone`
//      is frequently disallowed there, so even where it technically resolves, it can't be relied
//      on.
// The sidepanel is a real, persistently-open extension page (exactly like Task 13's video call
// surface), so it's the only place both exported functions here can safely be called from.
//
// Max recording length: 10,000ms (10 seconds) - picked as a concrete value rather than left vague
// ("e.g. 10 seconds" per this task's brief). This is enforced INSIDE this module, not just as a UI
// countdown/disable-button affordance: startRecording() schedules its own internal `setTimeout`
// that calls the MediaRecorder's own `.stop()` directly the moment the cap elapses, entirely
// independent of whether or when the caller ever calls stopRecording() - see MAX_RECORDING_MS and
// `autoStopTimer` below. stopRecording() itself does not additionally trust that the cap was
// respected (there would be nothing left for it to enforce - by the time it's called, the
// recording has either already been auto-stopped by the timer, or the caller genuinely stopped it
// early - either way, what actually got captured by MediaRecorder is the true source of the
// resulting Blob, not something stopRecording() could second-guess after the fact). The one
// remaining sub-cap trust point - the reported duration - is independently clamped to
// MAX_RECORDING_MS below (getLastRecordingDurationMs), so even a few milliseconds of setTimeout
// scheduling slop can never report a duration exceeding the cap.
export const MAX_RECORDING_MS = 10_000;

interface ActiveRecording {
  // Resolves once getUserMedia has succeeded and the MediaRecorder has actually started -
  // stopRecording() awaits this first, so a stop requested before the permission prompt has even
  // resolved still does the right thing (stop as soon as recording genuinely starts) instead of
  // racing against not-yet-existent recorder state. Rejects with whatever getUserMedia rejected
  // with (e.g. a real "permission denied" DOMException) - propagated as-is to stopRecording()'s
  // caller, since there is nothing this module can do to recover from the user declining the
  // browser's own mic-access prompt.
  ready: Promise<void>;
  // Resolves with the assembled Blob once the MediaRecorder's own "stop" event fires - shared by
  // both an explicit stopRecording() call and the internal auto-stop timer, so whichever happens
  // FIRST is what actually produces the Blob; the other is just a `.stop()` call against an
  // already-inactive recorder, which MediaRecorder's spec defines as a harmless no-op.
  stopped: Promise<Blob>;
  requestStop: () => void;
}

let active: ActiveRecording | null = null;
let lastRecordingStartedAt: number | null = null;
let lastRecordingDurationMs: number | null = null;

// Best-effort mimeType negotiation: 'audio/webm;codecs=opus' is well-supported in Chrome (this
// extension's only target per this codebase's existing browser-support posture) and produces
// small files well within reason for a 10s clip; MediaRecorder.isTypeSupported guards against a
// future/different Chromium build that doesn't support it, falling back to the browser's own
// default mimeType choice (undefined options) rather than throwing.
function pickMimeType(): string | undefined {
  if (
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
  ) {
    return "audio/webm;codecs=opus";
  }
  return undefined;
}

export function startRecording(): void {
  // A prior recording that was never collected via stopRecording() (e.g. the UI navigated away
  // mid-recording) is defensively torn down first - mirrors videoCallClient.ts's joinCall() "tear
  // down a leaked prior connection before starting a new one" convention. Its own auto-stop timer
  // requestStop() harmlessly no-ops if the recorder already stopped itself.
  if (active) {
    active.requestStop();
    active = null;
  }

  lastRecordingStartedAt = Date.now();
  lastRecordingDurationMs = null;

  const chunks: Blob[] = [];
  let recorder: MediaRecorder | null = null;
  let autoStopTimer: ReturnType<typeof setTimeout> | null = null;

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        recorder = new MediaRecorder(stream, pickTypeOptions());
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        recorder.start();

        // The defense-in-depth cap: fires regardless of whether the caller ever calls
        // stopRecording() at all, or calls it late. `.stop()` on an already-inactive recorder is
        // a documented no-op per the MediaRecorder spec, so it's safe to call unconditionally
        // here without checking state first racing against a concurrent manual stop.
        autoStopTimer = setTimeout(() => {
          recorder?.stop();
        }, MAX_RECORDING_MS);

        resolveReady();
      })
      .catch(rejectReady);
  });

  // Attaching the "stop" listener inside `ready`'s `.then()` (a microtask that runs only after
  // `resolveReady()` above, which itself only runs after `recorder.start()` and the auto-stop
  // timer are already scheduled) guarantees this listener is registered before the earliest
  // possible moment the recorder could actually stop - JS microtasks always drain before the next
  // timer macrotask fires, so there is no window where the auto-stop timer could fire before this
  // listener is attached, even under fake timers in a test.
  const stopped = ready.then(
    () =>
      new Promise<Blob>((resolveStopped) => {
        const r = recorder as MediaRecorder;
        r.addEventListener("stop", () => {
          if (autoStopTimer) clearTimeout(autoStopTimer);
          if (lastRecordingStartedAt !== null) {
            // Clamped to the cap - a few milliseconds of setTimeout scheduling slop (or, in a
            // test, a fake-timer advance landing exactly on the boundary) must never report a
            // duration that exceeds MAX_RECORDING_MS, even though the actual browser-side capture
            // is already what enforces the real content length.
            lastRecordingDurationMs = Math.min(Date.now() - lastRecordingStartedAt, MAX_RECORDING_MS);
          }
          r.stream.getTracks().forEach((t) => t.stop());
          resolveStopped(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
        });
      })
  );
  // If getUserMedia is denied, `ready` rejects and that rejection propagates through this `.then`
  // to `stopped` too. The real error is already surfaced to the caller via stopRecording()
  // awaiting `ready` directly (and rethrowing before it would ever reach `stopped`) - this no-op
  // catch exists purely so `stopped` doesn't sit in module state as a second, never-observed
  // rejected promise (which Node/the test runner would otherwise flag as an unhandled rejection).
  stopped.catch(() => {});

  active = {
    ready,
    stopped,
    requestStop: () => {
      recorder?.stop();
    },
  };
}

function pickTypeOptions(): MediaRecorderOptions | undefined {
  const mimeType = pickMimeType();
  return mimeType ? { mimeType } : undefined;
}

// Resolves with the recorded clip once recording has genuinely stopped - either because this call
// requested it, or because startRecording()'s own internal cap already had. Throws (via the
// rejected `ready` promise) if no recording is in progress, or if getUserMedia was ever denied.
export async function stopRecording(): Promise<Blob> {
  if (!active) {
    throw new Error("No recording in progress.");
  }
  const current = active;
  await current.ready;
  current.requestStop();
  const blob = await current.stopped;
  if (active === current) active = null;
  return blob;
}

// The actual elapsed recording time (wall-clock start -> the MediaRecorder's own "stop" event),
// clamped to MAX_RECORDING_MS - NOT simply assumed to equal the cap. Read by
// producerTagApi.uploadTag()'s caller (the sidepanel panels) immediately after stopRecording()
// resolves, since stopRecording() itself must keep its Promise<Blob> return type exactly matching
// this task's plan. Returns null before any recording has ever completed.
export function getLastRecordingDurationMs(): number | null {
  return lastRecordingDurationMs;
}
