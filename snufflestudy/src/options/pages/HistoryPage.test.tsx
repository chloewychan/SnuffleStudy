import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HistoryPage, HISTORY_LIST_LIMIT } from "./HistoryPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { StudySession, SessionEvent } from "../../domain/session/sessionTypes";

beforeEach(() => {
  vi.restoreAllMocks();
});

function buildSession(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "session_1",
    goal: "Finish 20 chemistry problems",
    state: "ABANDONED",
    interventionLevel: "none",
    activityState: "active",
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    focusDurationSeconds: 1500,
    breakDurationSeconds: 300,
    pressureProfileId: "strict-coach",
    allowedSites: [],
    restrictedSites: ["youtube.com"],
    restrictionMode: "soft",
    accountabilityUserIds: [],
    distractionAttempts: 2,
    recoveries: 1,
    friendNudges: 0,
    ...overrides,
  };
}

describe("HistoryPage", () => {
  it("loads sessions on mount via SESSION_LIST_HISTORY and renders them", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      sessions: [buildSession()],
    });

    render(<HistoryPage />);

    expect(await screen.findByText("Finish 20 chemistry problems")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "SESSION_LIST_HISTORY",
      payload: { limit: HISTORY_LIST_LIMIT },
    });
  });

  it("bounds the query with a default limit so an unfiltered load doesn't fetch the entire history", async () => {
    // Regression guard for the review finding: without a "From" date, the query must stay
    // bounded (HistoryQuery.limit) rather than fetching every archived session on every load.
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, sessions: [buildSession()] });

    render(<HistoryPage />);
    await screen.findByText("Finish 20 chemistry problems");

    const call = sendMessageSpy.mock.calls[0]![0] as { payload: { limit?: number } };
    expect(call.payload.limit).toBe(HISTORY_LIST_LIMIT);
    expect(call.payload.limit).toBeGreaterThan(0);
  });

  it("shows a message when no sessions match the filters", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, sessions: [] });

    render(<HistoryPage />);

    expect(await screen.findByText("No sessions match these filters.")).toBeInTheDocument();
  });

  it("surfaces an error instead of hanging when SESSION_LIST_HISTORY fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<HistoryPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("re-queries with a state filter when Status is changed", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, sessions: [buildSession()] });

    render(<HistoryPage />);
    await screen.findByText("Finish 20 chemistry problems");

    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "COMPLETED" } });

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_LIST_HISTORY",
        payload: { state: "COMPLETED", limit: HISTORY_LIST_LIMIT },
      })
    );
  });

  it("re-queries with a since timestamp when the From date is changed", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, sessions: [buildSession()] });

    render(<HistoryPage />);
    await screen.findByText("Finish 20 chemistry problems");

    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2024-01-01" } });

    await waitFor(() => {
      const lastCall = sendMessageSpy.mock.calls.at(-1)![0] as {
        type: string;
        payload: { since?: number };
      };
      expect(lastCall.type).toBe("SESSION_LIST_HISTORY");
      expect(lastCall.payload.since).toBe(new Date("2024-01-01T00:00:00").getTime());
    });
  });

  it("filters the displayed sessions by the To date on the client, without an extra query", async () => {
    const early = buildSession({ id: "session_early", createdAt: new Date("2024-01-01T12:00:00").getTime() });
    const late = buildSession({ id: "session_late", createdAt: new Date("2024-06-01T12:00:00").getTime() });
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, sessions: [late, early] });

    render(<HistoryPage />);
    await screen.findAllByText("Finish 20 chemistry problems");

    const callCountBefore = sendMessageSpy.mock.calls.length;
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2024-02-01" } });

    await waitFor(() => {
      expect(screen.getAllByText("Finish 20 chemistry problems")).toHaveLength(1);
    });
    // Filtering by "To" is applied client-side over the already-fetched sessions (HistoryQuery
    // has no "until" field) - it must not trigger a redundant SESSION_LIST_HISTORY call.
    expect(sendMessageSpy.mock.calls.length).toBe(callCountBefore);
  });

  it("fetches and displays a session's event log when expanded, in chronological order", async () => {
    const events: SessionEvent[] = [
      { id: "e2", sessionId: "session_1", type: "USER_RETURNED_FROM_IDLE", occurredAt: 2000 },
      { id: "e1", sessionId: "session_1", type: "DISTRACTION_ATTEMPT", occurredAt: 1000, hostname: "youtube.com" },
    ];
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SESSION_LIST_HISTORY") return { ok: true, sessions: [buildSession()] };
      if (message.type === "SESSION_LIST_EVENTS") return { ok: true, events };
      throw new Error(`unexpected message ${message.type}`);
    });

    const { container } = render(<HistoryPage />);
    await screen.findByText("Finish 20 chemistry problems");

    fireEvent.click(screen.getByRole("button", { name: /Finish 20 chemistry problems/ }));

    expect(await screen.findByText("Distraction attempt")).toBeInTheDocument();
    expect(screen.getByText("Returned from idle")).toBeInTheDocument();

    // Chronological order: the DISTRACTION_ATTEMPT (occurredAt: 1000) should render before
    // USER_RETURNED_FROM_IDLE (occurredAt: 2000), regardless of the order the API returned them in.
    const eventItems = container.querySelectorAll(".history-page__event-list li");
    expect(eventItems).toHaveLength(2);
    expect(eventItems[0]).toHaveTextContent("Distraction attempt");
    expect(eventItems[1]).toHaveTextContent("Returned from idle");
  });

  it("renders two consecutive USER_WENT_IDLE events without assuming alternation", async () => {
    // Carried forward from Task 2's review: an idle -> locked transition (without returning
    // to active first) can record two consecutive USER_WENT_IDLE events with no
    // USER_RETURNED_FROM_IDLE in between. The timeline must render both, not pair them up.
    const events: SessionEvent[] = [
      { id: "e1", sessionId: "session_1", type: "USER_WENT_IDLE", occurredAt: 1000 },
      { id: "e2", sessionId: "session_1", type: "USER_WENT_IDLE", occurredAt: 2000 },
    ];
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SESSION_LIST_HISTORY") return { ok: true, sessions: [buildSession()] };
      if (message.type === "SESSION_LIST_EVENTS") return { ok: true, events };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<HistoryPage />);
    await screen.findByText("Finish 20 chemistry problems");
    fireEvent.click(screen.getByRole("button", { name: /Finish 20 chemistry problems/ }));

    expect(await screen.findAllByText("Went idle")).toHaveLength(2);
  });

  it("does not re-fetch events when a session is collapsed and re-expanded", async () => {
    const events: SessionEvent[] = [
      { id: "e1", sessionId: "session_1", type: "SESSION_STARTED", occurredAt: 1000 },
    ];
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SESSION_LIST_HISTORY") return { ok: true, sessions: [buildSession()] };
      if (message.type === "SESSION_LIST_EVENTS") return { ok: true, events };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<HistoryPage />);
    await screen.findByText("Finish 20 chemistry problems");
    const summaryButton = screen.getByRole("button", { name: /Finish 20 chemistry problems/ });

    fireEvent.click(summaryButton);
    await screen.findByText("Session started");
    fireEvent.click(summaryButton); // collapse
    fireEvent.click(summaryButton); // expand again

    await waitFor(() => {
      const eventCalls = sendMessageSpy.mock.calls.filter(
        (call) => (call[0] as { type: string }).type === "SESSION_LIST_EVENTS"
      );
      expect(eventCalls).toHaveLength(1);
    });
  });

  it("surfaces an error for the expanded session when SESSION_LIST_EVENTS fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SESSION_LIST_HISTORY") return { ok: true, sessions: [buildSession()] };
      if (message.type === "SESSION_LIST_EVENTS") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      throw new Error(`unexpected message ${message.type}`);
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<HistoryPage />);
    await screen.findByText("Finish 20 chemistry problems");
    fireEvent.click(screen.getByRole("button", { name: /Finish 20 chemistry problems/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
