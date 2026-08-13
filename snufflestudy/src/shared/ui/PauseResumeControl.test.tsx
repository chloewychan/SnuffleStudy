import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PauseResumeControl } from "./PauseResumeControl";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PauseResumeControl", () => {
  it("renders a Pause button while FOCUSING and sends SESSION_PAUSE on click", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session });

    render(<PauseResumeControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_PAUSE",
        payload: { sessionId: "session_1" },
      })
    );
  });

  it("renders a Resume button while PAUSED and sends SESSION_RESUME on click", async () => {
    const focusing = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const paused = machine.pauseSession(focusing, 100);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: paused });

    render(<PauseResumeControl session={paused} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_RESUME",
        payload: { sessionId: "session_1" },
      })
    );
  });

  it("renders nothing during a BREAK, where pause/resume don't apply", () => {
    const focusing = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const onBreak = machine.startBreak(focusing, 100);

    render(<PauseResumeControl session={onBreak} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not crash or leave an unhandled rejection when sendMessage rejects", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<PauseResumeControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});
