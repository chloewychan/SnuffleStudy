import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CompletionScreen } from "./CompletionScreen";
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

describe("CompletionScreen", () => {
  it("shows the completed goal and sends SESSION_DISMISS_COMPLETED on click", async () => {
    const completed = machine.completeSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(<CompletionScreen session={completed} />);
    expect(screen.getByText("Finish 20 chemistry problems")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start another session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_DISMISS_COMPLETED",
        payload: { sessionId: "session_1" },
      })
    );
  });

  it("does not crash or leave an unhandled rejection when sendMessage rejects", async () => {
    const completed = machine.completeSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<CompletionScreen session={completed} />);
    fireEvent.click(screen.getByRole("button", { name: "Start another session" }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "Start another session" })).toBeInTheDocument();
  });
});
