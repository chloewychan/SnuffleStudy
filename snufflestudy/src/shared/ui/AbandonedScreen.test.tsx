import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AbandonedScreen } from "./AbandonedScreen";
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

describe("AbandonedScreen", () => {
  it("shows the goal and sends SESSION_DISMISS_ABANDONED on click", async () => {
    const abandoned = machine.abandonSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, count: 0 });

    render(<AbandonedScreen session={abandoned} />);
    expect(screen.getByText("Finish 20 chemistry problems")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start another session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_DISMISS_ABANDONED",
        payload: { sessionId: "session_1" },
      })
    );
  });

  it("does not use punitive/certainty-claiming language about distraction", async () => {
    const abandoned = machine.abandonSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, count: 0 });

    const { container } = render(<AbandonedScreen session={abandoned} />);

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/distract|fail|guilt|shame|weak|blew it/i);
  });

  it("fetches and displays the count of past abandoned sessions via SESSION_COUNT_BY_STATE", async () => {
    const abandoned = machine.abandonSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      count: 3,
    });

    render(<AbandonedScreen session={abandoned} />);

    expect(await screen.findByText("This is your 3rd session ended early.")).toBeInTheDocument();
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "SESSION_COUNT_BY_STATE",
      payload: { state: "ABANDONED" },
    });
  });

  it("does not render a count line when the count fetch fails", async () => {
    const abandoned = machine.abandonSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<AbandonedScreen session={abandoned} />);

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(screen.queryByText(/session ended early\./)).not.toBeInTheDocument();
  });

  it("does not crash or leave an unhandled rejection when the dismiss sendMessage rejects", async () => {
    const abandoned = machine.abandonSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValueOnce({ ok: true, count: 0 })
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<AbandonedScreen session={abandoned} />);
    fireEvent.click(screen.getByRole("button", { name: "Start another session" }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "Start another session" })).toBeInTheDocument();
  });
});
