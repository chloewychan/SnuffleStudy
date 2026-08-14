import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
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
    // A fresh install (onboardingCompleted: false) shows OnboardingWizard's welcome screen
    // first, before its "name" step ("Meet Snuffles").
    await waitFor(() => expect(screen.getByText("Welcome to SnuffleStudy")).toBeInTheDocument());
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

  it("shows a Pause control while FOCUSING, and a Resume control while PAUSED", async () => {
    // Regression guard: pause/resume previously only existed in PopupApp, never in
    // SidePanelApp at all.
    const focusing = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: focusing };
      return { ok: true };
    });

    const { unmount } = render(<SidePanelApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
    unmount();

    const paused = machine.pauseSession(focusing, 100);
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: paused };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument());
  });

  it("shows the completion screen instead of the timer when the session is COMPLETED", async () => {
    const completed = machine.completeSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: completed };
      return { ok: true };
    });

    render(<SidePanelApp />);

    await waitFor(() => expect(screen.getByText("Goal complete!")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start another session" })).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("ticks the countdown down every second while open, without needing to reopen the side panel", async () => {
    const start = Date.now();
    const session = machine.startSession(machine.createSession(input, "session_1", start), start);
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session };
      return { ok: true };
    });

    // See PopupApp.test.tsx's equivalent test for why fake timers must be installed
    // before render (useNow's setInterval is registered on the first effect flush).
    vi.useFakeTimers();
    try {
      render(<SidePanelApp />);
      await act(async () => {
        await Promise.resolve();
      });

      const initialLabel = screen.getByRole("timer").textContent;

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(screen.getByRole("timer").textContent).not.toBe(initialLabel);
    } finally {
      vi.useRealTimers();
    }
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

  it("opens Task Vault and pre-fills the session goal from a breakdown item's 'Start a session from this' action", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      if (message.type === "TASK_LIST") {
        return {
          ok: true,
          tasks: [
            {
              id: "task_1",
              title: "STAT231",
              createdAt: 1000,
              breakdown: [{ id: "item_1", description: "Chapter 6 of STAT231" }],
            },
          ],
        };
      }
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Finish 20 chemistry problems")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Task Vault" }));
    await screen.findByText("Chapter 6 of STAT231");

    fireEvent.click(screen.getByRole("button", { name: "Start a session from this" }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Finish 20 chemistry problems")).toHaveValue(
        "Chapter 6 of STAT231"
      )
    );
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
