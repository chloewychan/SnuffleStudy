import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EndSessionControl } from "./EndSessionControl";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";

const softInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

const hardInput: CreateSessionInput = { ...softInput, restrictionMode: "hard" };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("EndSessionControl", () => {
  it("ends a soft-mode session immediately on a single click, with no passcode prompt", async () => {
    const session = machine.startSession(machine.createSession(softInput, "session_1", 0), 0);
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, session: null });

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_END",
        payload: { sessionId: "session_1" },
      })
    );
    expect(screen.queryByPlaceholderText("Passcode")).not.toBeInTheDocument();
  });

  it("reveals an inline passcode prompt instead of sending immediately for a hard-mode session", () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));

    expect(screen.getByPlaceholderText("Passcode")).toBeInTheDocument();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("ends the hard-mode session when the correct passcode is submitted", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, session: null });

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_END",
        payload: { sessionId: "session_1", passcode: "1234" },
      })
    );
  });

  it("shows an error and keeps the prompt open when the passcode is incorrect, leaving the session active", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: false,
      error: "Incorrect passcode, or temporarily locked after repeated attempts.",
    });

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Incorrect passcode/);
    // The prompt is still showing (i.e. the control never treated the session as ended).
    expect(screen.getByPlaceholderText("Passcode")).toBeInTheDocument();
  });

  it("shows an error and does not leave an unhandled rejection when the passcode sendMessage call rejects", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("disables the submit button and shows a loading label while the passcode request is in flight", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    let resolvePromise: (value: { ok: boolean }) => void = () => {};
    vi.spyOn(messenger, "sendMessage").mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }) as ReturnType<typeof messenger.sendMessage>
    );

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    const submitButton = await screen.findByRole("button", { name: "Checking…" });
    expect(submitButton).toBeDisabled();

    resolvePromise({ ok: true });
    // Submitting reverts once the request settles (a real successful end also causes the
    // parent's active-session subscription to swap this whole view out, but that's outside
    // this component's own responsibility/test scope).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm end session" })).not.toBeDisabled()
    );
  });
});
