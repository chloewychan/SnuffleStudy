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
    // The tab shell defaults to the "Bunny" tab (Task 3/10) - the session setup form now lives
    // inside the "Study" tab (Task 6's StudyTab), reached via TabBar rather than shown by default.
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Study" }));

    // Goal is a <select> populated from the Task Vault (Task 5), not a free-text input with a
    // placeholder - assert on the labeled control that actually exists now.
    await waitFor(() => expect(screen.getByLabelText(/goal/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start session" })).toBeInTheDocument();
  });

  it("routes each of the four tabs to its own distinct content (Fix 12: only Study was previously tested)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());

    // One real, source-verified heading per tab's actual content (not guessed): BunnyTab.tsx's
    // <h2>About the Bun</h2>, TaskVaultPage.tsx's <h2>Task Vault</h2> (inside StudyTab),
    // StudyRoomPanel.tsx's <h2>Study Rooms</h2> (inside FriendsTab), and (v3.3 Task 7)
    // SettingsPage.tsx's <h2>Tracking</h2> - the first section of the sidepanel Settings tab's now
    // real (no longer empty-placeholder) default "settings" sub-view. This is the single most
    // transposition-prone spot in SidePanelApp.tsx's four-way conditional - would ship green even
    // with two tabs swapped without a check like this covering all four.
    //
    // v3.3 Task 1 moved TempPasscodePanel.tsx's <h2>Temporary passcode requests</h2> and
    // UnlockRequestPanel.tsx's <h2>Unlock requests</h2> from SettingsTab.tsx into FriendsTab.tsx,
    // below its existing StudyRoomPanel/FriendGroupPanel, leaving SettingsTab.tsx emptied as a
    // placeholder. v3.3 Task 7 then rebuilt that placeholder into a real Settings/Account/Friends/
    // History sub-nav (SettingsTab.test.tsx covers that sub-nav's own four-way switch in detail) -
    // this test only needs SettingsTab's default "settings" sub-view to have its own distinguishing
    // heading again, same as the other three tabs.
    const tabs = [
      { tabName: "Bunny", heading: /^about the bun$/i },
      { tabName: "Study", heading: /^task vault$/i },
      { tabName: "Friends", heading: /^study rooms$/i },
      { tabName: "Settings", heading: /^tracking$/i },
    ];

    for (const { tabName, heading } of tabs) {
      fireEvent.click(screen.getByRole("tab", { name: tabName }));
      await waitFor(() => expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument());

      // Only the clicked tab's content is mounted inside the shared tabpanel - every other tab's
      // distinguishing heading must be absent.
      for (const other of tabs) {
        if (other.tabName === tabName) continue;
        expect(screen.queryByRole("heading", { name: other.heading })).not.toBeInTheDocument();
      }
      if (tabName !== "Settings") {
        expect(document.querySelector(".sp-settings-tab")).not.toBeInTheDocument();
      }
    }
  });

  // QA-discovered bug (v3.3 QA pass): SidePanelApp.tsx owns its own top-level `settings` state,
  // fetched once on mount and passed down to StudyTab -> SessionSetupForm. SettingsPage.tsx (Task
  // 7's new sidepanel Settings tab) fetches and saves its OWN, entirely separate `settings` state -
  // saving a change there (e.g. adding a restricted site) persists correctly in the background, but
  // never told SidePanelApp's own copy to refresh. Starting a session immediately afterward, from
  // the same sidepanel session with no reload, used SidePanelApp's stale settings - a newly-added
  // restricted site was silently dropped from that session's own restrictedSites (reproduced live:
  // the site wasn't blocked, and didn't appear in the active-session view's own restricted-sites
  // list either, since both are built from the session's persisted restrictedSites at creation
  // time, not the fresh setting).
  it("uses a freshly-saved restricted site when starting a session right after editing it in the Settings tab", async () => {
    const sessionCreatePayloads: unknown[] = [];
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return {
          ok: true,
          settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true, defaultRestrictedSites: [] },
        };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      if (message.type === "SETTINGS_SAVE") return { ok: true };
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "SESSION_CREATE") {
        sessionCreatePayloads.push(message.payload);
        return { ok: true, session: { id: "session_1" } };
      }
      if (message.type === "SESSION_START") return { ok: true };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /tracking/i })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Default restricted sites"), {
      target: { value: "youtube.com" },
    });
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SETTINGS_SAVE",
          payload: expect.objectContaining({ defaultRestrictedSites: ["youtube.com"] }),
        })
      )
    );

    fireEvent.click(screen.getByRole("tab", { name: "Study" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start session" })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(sessionCreatePayloads.length).toBeGreaterThan(0));
    expect(sessionCreatePayloads[0]).toMatchObject({ restrictedSites: ["youtube.com"] });
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
    // ActiveSessionView (Task 9) shows the goal twice by design - once as its own headline, once
    // inside the reused SessionStatusCard (see ActiveSessionView.test.tsx for the same assertion
    // shape and rationale) - so getAllByText/length is used instead of a single getByText.
    await waitFor(() =>
      expect(screen.getAllByText("Finish 20 chemistry problems").length).toBe(2)
    );
    expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument();
  });

  it("replaces ActiveSessionView with UnlockRequestPanel (not an overlay) when 'Unlock requests' is triggered, and restores it on close", async () => {
    // Regression guard for a panel-stacking bug introduced mid-Task-10 and reverted in a
    // follow-up fix (see SidePanelApp.tsx's showUnlockPanel branch comment): opening this panel
    // must fully replace ActiveSessionView's contents, the same "swap in a different screen
    // entirely" pattern the COMPLETED/ABANDONED branches use - not render alongside it.
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session };
      // UnlockRequestPanel's own fetches on mount (AUTH_GET_SESSION/UNLOCK_REQUESTS_FETCH/
      // SESSION_LIST_EVENTS) - given healthy, empty-but-ok responses so it renders cleanly,
      // matching UnlockRequestPanel.test.tsx's routeSendMessage default conventions.
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      if (message.type === "UNLOCK_REQUESTS_FETCH") return { ok: true, requests: [] };
      if (message.type === "SESSION_LIST_EVENTS") return { ok: true, events: [] };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument()
    );

    // ActiveSessionView's own trigger button (distinct from UnlockRequestPanel's identically
    // worded <h2> heading below - only one of the two exists in the DOM at a time).
    fireEvent.click(screen.getByRole("button", { name: "Unlock requests" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Unlock requests" })).toBeInTheDocument()
    );
    // ActiveSessionView's content is gone entirely, not merely covered - this is the crux of the
    // regression this test guards against.
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End session" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument()
    );
    expect(screen.queryByRole("heading", { name: "Unlock requests" })).not.toBeInTheDocument();
  });

  it("replaces ActiveSessionView with TempPasscodePanel (not an overlay) when 'Temp passcode requests' is triggered, and restores it on close", async () => {
    // Symmetric guard to the "Unlock requests" test above (Fix 12) - Task 10's regression test
    // only covered the showUnlockPanel path even though SidePanelApp.tsx's showTempPasscodePanel
    // branch is the exact same shape (see that branch's own "same reachable-during-an-active-
    // session, replaces-not-overlays treatment as UnlockRequestPanel above" comment).
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session };
      // TempPasscodePanel's own fetches on mount (AUTH_GET_SESSION/TEMP_PASSCODE_REQUESTS_FETCH) -
      // given healthy, empty-but-ok responses so it renders cleanly, matching
      // TempPasscodePanel.test.tsx's own conventions.
      if (message.type === "AUTH_GET_SESSION") return { ok: true, session: null };
      if (message.type === "TEMP_PASSCODE_REQUESTS_FETCH") return { ok: true, requests: [] };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument()
    );

    // ActiveSessionView's own trigger button (distinct from TempPasscodePanel's own <h2> heading
    // below - only one of the two exists in the DOM at a time).
    fireEvent.click(screen.getByRole("button", { name: "Temp passcode requests" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Temporary passcode requests" })
      ).toBeInTheDocument()
    );
    // ActiveSessionView's content is gone entirely, not merely covered - same crux as the
    // Unlock-requests regression guard above.
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End session" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument()
    );
    expect(
      screen.queryByRole("heading", { name: "Temporary passcode requests" })
    ).not.toBeInTheDocument();
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

  it("shows the abandoned screen instead of the timer when the session is ABANDONED", async () => {
    const abandoned = machine.abandonSession(
      machine.startSession(machine.createSession(input, "session_1", 0), 0),
      100
    );
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: abandoned };
      return { ok: true };
    });

    render(<SidePanelApp />);

    await waitFor(() => expect(screen.getByText("Session ended early")).toBeInTheDocument());
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

  it("pre-fills the session goal from a Task Vault breakdown item's 'Start a session from this' action", async () => {
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
    // Task Vault is no longer a separate routed view reached via its own button - it's embedded
    // directly inside the "Study" tab (Task 6's StudyTab) alongside the session setup form.
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Study" }));

    await screen.findByText("Chapter 6 of STAT231");

    fireEvent.click(screen.getByRole("button", { name: "Start a session from this" }));

    // Goal is a <select> populated from the Task Vault (Task 5), not a free-text input with a
    // placeholder - assert on the labeled control's value instead.
    await waitFor(() =>
      expect(screen.getByLabelText(/goal/i)).toHaveValue("Chapter 6 of STAT231")
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
