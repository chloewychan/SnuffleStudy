import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SidePanelApp } from "./SidePanelApp";
import * as messenger from "../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../domain/settings/userSettings";
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

describe("SidePanelApp", () => {
  it("shows onboarding when settings.onboardingCompleted is false", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() => expect(screen.getByText("Meet Snuffles")).toBeInTheDocument());
  });

  it("shows the session setup form when onboarding is complete and there is no active session", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Finish 20 chemistry problems")).toBeInTheDocument()
    );
  });

  it("shows the active session view with an End session control", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() => expect(screen.getByText("Finish 20 chemistry problems")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument();
  });

  it("surfaces an error instead of hanging on Loading… when the initial settings fetch rejects", async () => {
    // sendMessage (chrome.runtime.sendMessage) can reject — e.g. during service-worker
    // startup races or extension-context-invalidated. The whole app is gated behind this
    // call succeeding, so it must not be left stuck on "Loading…" forever with no signal.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SidePanelApp />);

    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("does not crash or leave an unhandled rejection when End session's sendMessage rejects", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session };
      if (message.type === "SESSION_END") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true };
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<SidePanelApp />);
    await waitFor(() => screen.getByRole("button", { name: "End session" }));

    screen.getByRole("button", { name: "End session" }).click();

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SESSION_END" })
      )
    );
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    // Component survives the rejection instead of crashing/unmounting.
    expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument();
  });
});
