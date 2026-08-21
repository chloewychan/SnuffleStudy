import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SnufflesOverlay } from "./SnufflesOverlay";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import { generateCoachingMessage } from "../../infrastructure/backend/coachingApi";
import type { StudySession } from "../../domain/session/sessionTypes";

// v2 Task 11: the network-dependent half of the overlay's coaching-message behavior
// (generateCoachingMessage's own timeout/fallback logic against supabase.functions.invoke) is
// covered by coachingApi.test.ts - this file mocks the whole module so SnufflesOverlay's tests
// only exercise ITS OWN responsibility: rendering the static message immediately, swapping in
// whatever generateCoachingMessage eventually resolves to, and never swapping in a late arrival
// after the user has dismissed the warning.
vi.mock("../../infrastructure/backend/coachingApi", () => ({
  generateCoachingMessage: vi.fn(),
}));

// pickWarningMessage itself is NOT mocked (deliberately) - genuinely exercising the real
// function (src/domain/pressure/pressureEngine.ts) against the real PRESSURE_PROFILES pool
// (src/domain/pressure/pressureProfiles.ts) is the whole point of this task's "activate the dead
// v1 code, don't reinvent it" requirement. Math.random is stubbed instead, to make pool selection
// deterministic (index 0) without touching pickWarningMessage's own logic at all.
const GENTLE_FIRST_WARNING = "Hey, is this part of the plan?"; // PRESSURE_PROFILES[0].firstWarningMessages[0]
const GENERIC_FALLBACK_MESSAGE = "You're supposed to be studying right now.";

function sessionFixture(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "session_1",
    goal: "Finish Chapter 6 of STAT231",
    state: "FOCUSING",
    interventionLevel: "none",
    activityState: "active",
    createdAt: Date.now(),
    focusDurationSeconds: 1500,
    breakDurationSeconds: 300,
    pressureProfileId: "gentle-encouragement",
    allowedSites: [],
    restrictedSites: [],
    restrictionMode: "blocklist",
    accountabilityUserIds: [],
    distractionAttempts: 0,
    recoveries: 0,
    ...overrides,
  } as StudySession;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // generateCoachingMessage is a plain vi.fn() from the vi.mock(...) factory above, not a
  // vi.spyOn() wrapping a real implementation - vi.restoreAllMocks() does not clear its call
  // history or reset its per-test mockReturnValue/mockResolvedValue, so that's done explicitly
  // here to keep each test's assertions (e.g. "not.toHaveBeenCalled()") isolated from whatever
  // an earlier test configured.
  vi.mocked(generateCoachingMessage).mockReset();
});

afterEach(() => {
  // document.referrer isn't a vi.* mock, so vi.restoreAllMocks() (beforeEach) doesn't touch
  // it - reset it explicitly so a value set by one test can't leak into the next.
  Object.defineProperty(document, "referrer", { value: "", configurable: true });
});

describe("SnufflesOverlay", () => {
  it("shows only the idle companion when the site is allowed", () => {
    render(
      <SnufflesOverlay
        classification="ALLOWED"
        sessionId="session_1"
        hostname="docs.google.com"
        reducedMotion={false}
      />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a warning with actions when the site is blocked", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to work" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark this site as study-related" })).toBeInTheDocument();
  });

  it("sends MARK_SITE_STUDY_RELATED and dismisses the warning when clicked", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, session: null });
    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark this site as study-related" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "MARK_SITE_STUDY_RELATED",
        payload: { sessionId: "session_1", hostname: "youtube.com" },
      })
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("navigates the tab back when the restricted site was reached from another page", async () => {
    Object.defineProperty(document, "referrer", {
      value: "https://example.com/article",
      configurable: true,
    });
    const historyBackSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Return to work" }));

    expect(historyBackSpy).toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "RETURN_TO_WORK_CLOSE_TAB" })
    );
  });

  it("closes the tab when the restricted site was opened fresh (no referrer)", async () => {
    Object.defineProperty(document, "referrer", { value: "", configurable: true });
    const historyBackSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation((message) => {
      if (message.type === "RETURN_TO_WORK_CLOSE_TAB") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true, session: null });
    });

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Return to work" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({ type: "RETURN_TO_WORK_CLOSE_TAB" })
    );
    expect(historyBackSpy).not.toHaveBeenCalled();
  });

  it("does not crash or leave an unhandled rejection when closing the tab fails", async () => {
    Object.defineProperty(document, "referrer", { value: "", configurable: true });
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Return to work" }));

    // Two sendMessage calls happen: the mount-time SESSION_GET_ACTIVE fetch (from the coaching
    // message effect) and the click-time RETURN_TO_WORK_CLOSE_TAB - both rejected by the same
    // mock, both caught internally (neither becomes an unhandled rejection).
    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledWith({ type: "RETURN_TO_WORK_CLOSE_TAB" }));
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({ type: "SESSION_GET_ACTIVE" })
    );
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
  });

  it("uses the staticFrame image when reducedMotion is true", () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    render(
      <SnufflesOverlay classification="ALLOWED" sessionId="session_1" hostname="docs.google.com" reducedMotion />
    );
    // Resolved via chrome.runtime.getURL (see animationRegistry.ts), not a root-absolute literal
    // - a plain "/sprites/..." string would resolve against the host page's origin inside a real
    // content script, not the extension's. wxt/testing/fake-browser's chrome.runtime.getURL
    // resolves to chrome-extension://test-extension-id/<path>.
    expect(screen.getByAltText("Snuffles")).toHaveAttribute(
      "src",
      chrome.runtime.getURL("sprites/placeholder-focused.png")
    );
  });

  // === v2 Task 11: dynamic coaching messages ===

  it("renders pickWarningMessage's line immediately once the active session is fetched, with zero wait on generateCoachingMessage", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: sessionFixture(),
    });
    vi.spyOn(Math, "random").mockReturnValue(0); // deterministic pool[0] pick
    const deferred = createDeferred<string>();
    vi.mocked(generateCoachingMessage).mockReturnValue(deferred.promise);

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    await waitFor(() => expect(screen.getByText(GENTLE_FIRST_WARNING)).toBeInTheDocument());

    expect(generateCoachingMessage).toHaveBeenCalledWith({
      pressureProfileId: "gentle-encouragement",
      goal: "Finish Chapter 6 of STAT231",
      hostname: "youtube.com",
      interventionLevel: "none",
    });
  });

  it("swaps in the generated coaching message once it resolves, before the user dismisses the warning", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: sessionFixture(),
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const deferred = createDeferred<string>();
    vi.mocked(generateCoachingMessage).mockReturnValue(deferred.promise);

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    await waitFor(() => expect(screen.getByText(GENTLE_FIRST_WARNING)).toBeInTheDocument());

    deferred.resolve("Chapter 6 of STAT231 is waiting for you - back to it.");

    await waitFor(() =>
      expect(
        screen.getByText("Chapter 6 of STAT231 is waiting for you - back to it.")
      ).toBeInTheDocument()
    );
  });

  it("does not swap in a late-arriving generated message after the user already dismissed the warning", async () => {
    Object.defineProperty(document, "referrer", {
      value: "https://example.com/article",
      configurable: true,
    });
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: sessionFixture(),
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deferred = createDeferred<string>();
    vi.mocked(generateCoachingMessage).mockReturnValue(deferred.promise);

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    await waitFor(() => expect(screen.getByText(GENTLE_FIRST_WARNING)).toBeInTheDocument());

    // "Return to work" with a referrer set dismisses synchronously (no async sendMessage in that
    // branch) - the dismissedRef guard is already armed by the time the deferred promise below
    // resolves.
    fireEvent.click(screen.getByRole("button", { name: "Return to work" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    deferred.resolve("A generated line that arrived too late.");
    await deferred.promise;

    // Still idle - the late-arriving message was discarded, not rendered, and nothing logged an
    // error trying to update state for a dismissed warning.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("A generated line that arrived too late.")).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("degrades gracefully to the generic fallback message when SESSION_GET_ACTIVE itself fails, without calling generateCoachingMessage", async () => {
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("background asleep"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(GENERIC_FALLBACK_MESSAGE)).toBeInTheDocument();
    expect(generateCoachingMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
  });

  it("degrades gracefully to the generic fallback message when SESSION_GET_ACTIVE returns no active session", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });

    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(GENERIC_FALLBACK_MESSAGE)).toBeInTheDocument();
    expect(generateCoachingMessage).not.toHaveBeenCalled();
  });
});
