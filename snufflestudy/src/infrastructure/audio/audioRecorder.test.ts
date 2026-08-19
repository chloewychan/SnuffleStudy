import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startRecording, stopRecording, getLastRecordingDurationMs, MAX_RECORDING_MS } from "./audioRecorder";

// happy-dom (this codebase's vitest environment) implements neither MediaRecorder nor
// navigator.mediaDevices.getUserMedia - both are stubbed here, mirroring videoCallClient.test.ts's
// FakeRoom convention (a minimal stand-in exposing only the surface audioRecorder.ts actually
// calls, with instances tracked for test-only reflection).
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  stream: MediaStream;
  private listeners: Record<string, Array<(event?: unknown) => void>> = {};

  constructor(stream: MediaStream, options?: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, callback: (event?: unknown) => void) {
    (this.listeners[type] ??= []).push(callback);
  }

  start() {
    this.state = "recording";
  }

  // Per the real MediaRecorder spec, calling stop() while already inactive is a harmless no-op -
  // this fake mirrors that exactly, since audioRecorder.ts's cap-enforcement design depends on it
  // (both the auto-stop timer and a manual stopRecording() call it unconditionally).
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    for (const cb of this.listeners["dataavailable"] ?? []) {
      cb({ data: new Blob(["fake-audio-chunk"]) });
    }
    for (const cb of this.listeners["stop"] ?? []) cb();
  }
}

function makeFakeStream(): MediaStream {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track] } as unknown as MediaStream;
}

let getUserMediaMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeMediaRecorder.instances.length = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  getUserMediaMock = vi.fn().mockResolvedValue(makeFakeStream());
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: getUserMediaMock },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function latestRecorder(): FakeMediaRecorder {
  const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
  if (!recorder) throw new Error("No FakeMediaRecorder instance was constructed");
  return recorder;
}

describe("audioRecorder.startRecording / stopRecording", () => {
  // Module-level state (lastRecordingDurationMs) is shared across every test in this file (a
  // singleton module, same as videoCallClient.ts/studyRoomApi.ts's own module-scoped state) - this
  // assertion is only meaningful before any OTHER test's recording has completed and set it, so
  // it must run first. Ordered here, at the very top of the file's very first describe block, for
  // exactly that reason.
  // Both of the next two assertions are only true before ANY OTHER test in this file has ever
  // called startRecording() (module-level singleton state, same as videoCallClient.ts/
  // studyRoomApi.ts's own module-scoped state) - ordered first, for exactly that reason.
  it("getLastRecordingDurationMs is null before any recording has ever completed", () => {
    expect(getLastRecordingDurationMs()).toBeNull();
  });

  it("throws when stopRecording is called with no recording in progress", async () => {
    await expect(stopRecording()).rejects.toThrow("No recording in progress.");
  });

  it("requests mic permission and starts a MediaRecorder", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);

    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
    expect(latestRecorder().state).toBe("recording");
  });

  it("stopRecording resolves with the recorded Blob when called before the cap", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);

    const blob = await stopRecording();

    expect(blob).toBeInstanceOf(Blob);
    expect(latestRecorder().state).toBe("inactive");
  });

  it("throws when getUserMedia is denied, and never starts a recorder", async () => {
    getUserMediaMock.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    startRecording();

    await expect(stopRecording()).rejects.toThrow("Permission denied");
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    // Leaves `active` in a permanently-rejected state (stopRecording() threw before ever reaching
    // its own `active = null` reset) - recovers it back to a clean slate with a normal successful
    // recording, so this test doesn't poison every test that runs after it in this file.
    getUserMediaMock.mockResolvedValue(makeFakeStream());
    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    await stopRecording();
  });

  it("releases the microphone stream's tracks once stopped", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    getUserMediaMock.mockResolvedValue(stream);

    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    await stopRecording();

    expect(track.stop).toHaveBeenCalled();
  });
});

// The core defense-in-depth guarantee this task's brief calls out by name: "enforce the max-length
// cap inside stopRecording(), not just in the UI" - concretely, startRecording() must schedule its
// OWN internal auto-stop, independent of whether/when stopRecording() is ever called.
describe("audioRecorder — max-length cap enforcement", () => {
  it("auto-stops the MediaRecorder itself at MAX_RECORDING_MS even if stopRecording() is never called", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(latestRecorder().state).toBe("recording");

    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);

    // The recorder is inactive (capture has genuinely stopped) purely from the internal timer -
    // nothing here ever called stopRecording().
    expect(latestRecorder().state).toBe("inactive");
  });

  it("stopRecording() called AFTER the cap already fired still resolves, with a Blob capped at the auto-stop point (not a longer one)", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS); // internal auto-stop fires here

    // Simulate the caller being "late" - plenty of extra time passes before stopRecording() is
    // ever invoked. If the cap were only a UI-level affordance, a late stopRecording() call could
    // in principle capture more audio in the interim; it must not, because the recorder already
    // genuinely stopped above.
    await vi.advanceTimersByTimeAsync(5_000);

    const blob = await stopRecording();
    expect(blob).toBeInstanceOf(Blob);
    // Only one MediaRecorder.stop()-triggered "stop" event ever fired (the auto-stop's) - a late
    // stopRecording() call just observes that already-settled result, it doesn't start a second
    // recording window.
    expect(latestRecorder().state).toBe("inactive");
  });

  it("stopRecording() called immediately (well before the cap) still lets the internal timer's later no-op fire harmlessly", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    await stopRecording();

    // Advancing past MAX_RECORDING_MS after an already-completed manual stop must not throw or
    // double-resolve anything - MediaRecorder.stop() on an already-inactive recorder is a no-op
    // per spec (see FakeMediaRecorder.stop() above). A throw here would fail this test on its own,
    // with no assertion needed beyond letting it run to completion.
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);
    expect(latestRecorder().state).toBe("inactive");
  });

  it("getLastRecordingDurationMs reflects real elapsed time when stopped early, not the cap", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    await stopRecording();

    const duration = getLastRecordingDurationMs();
    expect(duration).not.toBeNull();
    expect(duration!).toBeGreaterThanOrEqual(3_000);
    expect(duration!).toBeLessThan(MAX_RECORDING_MS);
  });

  it("getLastRecordingDurationMs is clamped to MAX_RECORDING_MS, never exceeding it, once the cap is hit", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);
    await stopRecording();

    expect(getLastRecordingDurationMs()).toBe(MAX_RECORDING_MS);
  });

  it("a second startRecording() call defensively tears down a still-active prior recording", async () => {
    startRecording();
    await vi.advanceTimersByTimeAsync(0);
    const firstRecorder = latestRecorder();
    expect(firstRecorder.state).toBe("recording");

    startRecording();
    await vi.advanceTimersByTimeAsync(0);

    expect(firstRecorder.state).toBe("inactive");
    expect(latestRecorder().state).toBe("recording");
    expect(latestRecorder()).not.toBe(firstRecorder);
  });
});
