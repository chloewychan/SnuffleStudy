import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PopupApp } from "./PopupApp";
import * as messenger from "../infrastructure/messaging/extensionMessenger";
import * as machine from "../domain/session/sessionMachine";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

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
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
});

describe("PopupApp", () => {
  it("shows an idle message when there is no active session", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    render(<PopupApp />);
    await waitFor(() => expect(screen.getByText("No active session.")).toBeInTheDocument());
  });

  it("shows session status and pause control while FOCUSING", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session });
    render(<PopupApp />);
    await waitFor(() => expect(screen.getByText("Finish 20 chemistry problems")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("sends SESSION_PAUSE when the Pause button is clicked", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session });
    render(<PopupApp />);
    await waitFor(() => screen.getByRole("button", { name: "Pause" }));

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_PAUSE",
        payload: { sessionId: "session_1" },
      })
    );
  });

  it("stops loading and renders the idle view when the initial sendMessage rejects", async () => {
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    render(<PopupApp />);

    // Must not get stuck on the loading state forever.
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    expect(screen.getByText("No active session.")).toBeInTheDocument();
  });

  it("does not crash or leave an unhandled rejection when a button's sendMessage rejects", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValueOnce({ ok: true, session })
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<PopupApp />);
    await waitFor(() => screen.getByRole("button", { name: "Pause" }));

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    // Component survives the rejection instead of crashing/unmounting.
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});
