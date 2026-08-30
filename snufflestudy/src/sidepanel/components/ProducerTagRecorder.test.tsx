import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProducerTagRecorder } from "./ProducerTagRecorder";
import * as audioRecorder from "../../infrastructure/audio/audioRecorder";

// audioRecorder.ts itself is unit-tested directly (audioRecorder.test.ts) against a fake
// MediaRecorder/getUserMedia - this component is tested against a MOCKED audioRecorder module
// instead (same boundary-mocking convention as StudyRoomPanel.test.tsx mocking studyRoomApi/
// videoCallClient), so these tests are purely about ProducerTagRecorder's own UI wiring: does it
// call startRecording/stopRecording/getLastRecordingDurationMs correctly, and does it render the
// right step (record -> recording -> preview) at the right time.
vi.mock("../../infrastructure/audio/audioRecorder", () => ({
  MAX_RECORDING_MS: 10_000,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  getLastRecordingDurationMs: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(audioRecorder.startRecording).mockReset();
  vi.mocked(audioRecorder.stopRecording).mockReset();
  vi.mocked(audioRecorder.getLastRecordingDurationMs).mockReset().mockReturnValue(4200);
});

// Fake timers are only enabled WITHIN the two tests below that need to control the countdown
// interval directly - React Testing Library's waitFor/findBy* helpers poll via the global
// setTimeout too, so leaving fake timers on globally (without manually advancing them around
// every waitFor) would deadlock every other test in this file waiting on a promise that never
// gets a chance to settle. This safety-net afterEach restores real timers unconditionally
// (harmless no-op if a test never enabled them).
afterEach(() => {
  vi.useRealTimers();
});

describe("ProducerTagRecorder", () => {
  it("starts in the 'record' step, showing the cap in its label", () => {
    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send" />);
    expect(screen.getByText("Record a tag (10s max)")).toBeInTheDocument();
  });

  it("pressing 'Record' calls audioRecorder.startRecording and shows the recording indicator with a live countdown", async () => {
    vi.useFakeTimers();
    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send" />);

    fireEvent.click(screen.getByText("Record a tag (10s max)"));

    expect(audioRecorder.startRecording).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Recording… 0s / 10s");

    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByRole("status")).toHaveTextContent("Recording… 1s / 10s");
  });

  it("pressing 'Stop' calls audioRecorder.stopRecording and shows a preview with Send/Discard once it resolves", async () => {
    const blob = new Blob(["fake-audio"], { type: "audio/webm" });
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(blob);

    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send to friend" />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));

    await waitFor(() => expect(screen.getByText("Send to friend")).toBeInTheDocument());
    expect(audioRecorder.stopRecording).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Discard")).toBeInTheDocument();
    expect(document.querySelector("audio")).toBeInTheDocument();
  });

  it("auto-stops (without a manual 'Stop' click) once the visible countdown reaches the cap, mirroring audioRecorder.ts's own internal enforcement", async () => {
    vi.useFakeTimers();
    const blob = new Blob(["capped-audio"], { type: "audio/webm" });
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(blob);

    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send" />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));

    await vi.advanceTimersByTimeAsync(10_000);

    expect(audioRecorder.stopRecording).toHaveBeenCalledTimes(1);
    // No manual "Stop" click ever happened in this test - the transition to the preview step was
    // entirely driven by the countdown reaching MAX_RECORDING_MS on its own. Switch back to real
    // timers before this assertion, since the preview render depends on the mocked
    // stopRecording()'s promise microtask settling and React flushing state - already true by
    // this point (advanceTimersByTimeAsync flushes microtasks between ticks), so a plain
    // synchronous assertion is enough, no further waitFor/real-timer polling needed.
    expect(screen.getByText("Discard")).toBeInTheDocument();
  });

  it("pressing 'Send' calls onSend with the recorded blob and the ACTUAL duration from getLastRecordingDurationMs (not the UI's own elapsed estimate)", async () => {
    const blob = new Blob(["fake-audio"], { type: "audio/webm" });
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(blob);
    vi.mocked(audioRecorder.getLastRecordingDurationMs).mockReturnValue(3123);
    const onSend = vi.fn();

    render(<ProducerTagRecorder onSend={onSend} sending={false} sendLabel="Send" />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(screen.getByText("Send")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Send"));

    expect(onSend).toHaveBeenCalledWith(blob, 3123);
  });

  it("pressing 'Discard' clears the preview and returns to the 'record' step", async () => {
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(new Blob(["x"]));

    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send" />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(screen.getByText("Discard")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Discard"));

    expect(screen.getByText("Record a tag (10s max)")).toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });

  it("disables Send while sending, and shows 'Sending…'", async () => {
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(new Blob(["x"]));

    render(<ProducerTagRecorder onSend={vi.fn()} sending={true} sendLabel="Send" />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));

    await waitFor(() => expect(screen.getByText("Sending…")).toBeInTheDocument());
    // v4.2 Task 10: the Send action is now a ButtonLarge (button text nested in its own <h3>) -
    // toBeDisabled() only recognizes bona fide form controls, so this must target the actual
    // <button> via role rather than the text node getByText resolves to. Still verifies the exact
    // same thing (the Send control is disabled while sending).
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
  });

  it("disables Send when sendDisabled is set (e.g. no target picked yet)", async () => {
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(new Blob(["x"]));

    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send" sendDisabled />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeDisabled());
  });

  it("surfaces a recording error inline when stopRecording rejects (e.g. mic permission was denied)", async () => {
    vi.mocked(audioRecorder.stopRecording).mockRejectedValue(new Error("Permission denied"));

    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send" />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    // Falls back to the record step (no preview to show) rather than getting stuck.
    expect(screen.getByText("Record a tag (10s max)")).toBeInTheDocument();
  });

  // QA-discovered bug (v3.2 Task 9): getUserMedia() rejects with a real but genuinely confusing
  // browser message ("Permission dismissed") when this panel can't show the permission prompt at
  // all (a Chrome side-panel limitation - see mediaPermissions.ts). A real DOMException, not a
  // plain Error - the previous test's plain Error is a different, non-actionable failure.
  it("replaces the raw browser message with a clear one and offers a fix action for a NotAllowedError", async () => {
    vi.mocked(audioRecorder.stopRecording).mockRejectedValue(
      new DOMException("Permission dismissed", "NotAllowedError")
    );
    const tabsCreateSpy = vi.spyOn(chrome.tabs, "create").mockReturnValue(undefined as never);

    render(<ProducerTagRecorder onSend={vi.fn()} sending={false} sendLabel="Send" />);
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/can't be requested from this panel/i);
    expect(alert).not.toHaveTextContent("Permission dismissed");

    fireEvent.click(screen.getByRole("button", { name: /open a tab to grant access/i }));
    expect(tabsCreateSpy).toHaveBeenCalledWith({ url: expect.stringContaining("options.html") });
  });
});
