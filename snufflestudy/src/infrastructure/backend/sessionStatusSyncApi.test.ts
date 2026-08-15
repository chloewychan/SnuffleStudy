import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import {
  recordStatusEvent,
  fetchNewEventsForFriends,
  pollNewEventsForFriends,
  fetchFriendEventDetails,
  fetchFriendInterventionCount,
  fetchFriendFullHistory,
} from "./sessionStatusSyncApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// friendGroupApi.test.ts - nothing here ever lets the real client make a network call.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors friendGroupApi.test.ts's
// makeBuilder, plus `.gt`/`.order` for fetchNewEventsForFriends's query chain.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    insert: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    gt: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    insert: vi.fn(),
    select: vi.fn(),
    gt: vi.fn(),
    order: vi.fn(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.insert.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.gt.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  return builder;
}

function mockSignedIn(userId: string) {
  return vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session: { user: { id: userId } } },
    error: null,
  } as never);
}

function mockSignedOut() {
  return vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session: null },
    error: null,
  } as never);
}

describe("sessionStatusSyncApi.recordStatusEvent", () => {
  it("inserts a session_status_events row for the current user with the given type/sessionId/displayLabel", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await recordStatusEvent({
      type: "SESSION_STARTED",
      sessionId: "session-1",
      displayLabel: "started a focus session",
    });

    expect(fromSpy).toHaveBeenCalledWith("session_status_events");
    expect(builder.insert).toHaveBeenCalledTimes(1);
    const insertArg = builder.insert.mock.calls[0]![0] as {
      user_id: string;
      session_id: string;
      type: string;
      display_label: string;
      occurred_at: string;
    };
    expect(insertArg.user_id).toBe("user-a");
    expect(insertArg.session_id).toBe("session-1");
    expect(insertArg.type).toBe("SESSION_STARTED");
    expect(insertArg.display_label).toBe("started a focus session");
    // occurred_at is a client-set timestamptz (no DB default - see the schema migration).
    expect(() => new Date(insertArg.occurred_at).toISOString()).not.toThrow();
    expect(new Date(insertArg.occurred_at).getTime()).not.toBeNaN();
  });

  // v2 Task 10: hostname/goalText are optional and additive - when provided, they're written to
  // their own new columns (never into display_label - see the migration's comment on why
  // display_label stays generic).
  it("writes hostname/goal_text when provided (v2 Task 10)", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: null, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await recordStatusEvent({
      type: "DISTRACTION_ATTEMPT",
      sessionId: "session-1",
      displayLabel: "got distracted",
      hostname: "youtube.com",
      goalText: "Finish chapter 6",
    });

    const insertArg = builder.insert.mock.calls[0]![0] as {
      hostname: string | null;
      goal_text: string | null;
    };
    expect(insertArg.hostname).toBe("youtube.com");
    expect(insertArg.goal_text).toBe("Finish chapter 6");
  });

  it("writes hostname/goal_text as null when not provided", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: null, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await recordStatusEvent({
      type: "SESSION_STARTED",
      sessionId: "session-1",
      displayLabel: "started a focus session",
    });

    const insertArg = builder.insert.mock.calls[0]![0] as {
      hostname: string | null;
      goal_text: string | null;
    };
    expect(insertArg.hostname).toBeNull();
    expect(insertArg.goal_text).toBeNull();
  });

  it("is a no-op when there is no authenticated session (never touches the database)", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(
      recordStatusEvent({ type: "SESSION_STARTED", sessionId: "s1", displayLabel: "x" })
    ).resolves.toBeUndefined();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("degrades gracefully (does not throw) when the insert fails", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "insert failed" } }) as never
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordStatusEvent({ type: "SESSION_STARTED", sessionId: "s1", displayLabel: "x" })
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("degrades gracefully (does not throw) when getSession itself throws", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("boom"));
    const fromSpy = vi.spyOn(supabase, "from");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordStatusEvent({ type: "SESSION_STARTED", sessionId: "s1", displayLabel: "x" })
    ).resolves.toBeUndefined();
    expect(fromSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("sessionStatusSyncApi.fetchNewEventsForFriends", () => {
  it("selects session_status_events newer than sinceTimestamp and maps rows to camelCase FriendEvents", async () => {
    mockSignedIn("user-b");
    const builder = makeBuilder({
      data: [
        {
          id: "event-1",
          user_id: "user-a",
          session_id: "session-1",
          type: "SESSION_STARTED",
          display_label: "started a focus session",
          occurred_at: "2026-01-01T00:00:05.000Z",
        },
      ],
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const since = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = await fetchNewEventsForFriends(since);

    expect(fromSpy).toHaveBeenCalledWith("session_status_events");
    expect(builder.gt).toHaveBeenCalledWith("occurred_at", new Date(since).toISOString());
    expect(result).toEqual([
      {
        id: "event-1",
        userId: "user-a",
        sessionId: "session-1",
        type: "SESSION_STARTED",
        displayLabel: "started a focus session",
        occurredAt: new Date("2026-01-01T00:00:05.000Z").getTime(),
      },
    ]);
  });

  it("returns [] when there is no authenticated session (never touches the database)", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await fetchNewEventsForFriends(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a query error", async () => {
    mockSignedIn("user-b");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchNewEventsForFriends(0);

    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// Fix round 1: alarmHandlers.ts's friend-poll alarm needs to distinguish "the fetch failed" from
// "genuinely no new events" so it only advances its persisted last-checked cursor on confirmed
// success (see that file's handleFriendPollAlarm) - fetchNewEventsForFriends's plain `[]` return
// can't make that distinction, which is exactly why this richer-return variant exists.
describe("sessionStatusSyncApi.pollNewEventsForFriends", () => {
  it("returns ok: true with the mapped events on a successful query", async () => {
    mockSignedIn("user-b");
    const builder = makeBuilder({
      data: [
        {
          id: "event-1",
          user_id: "user-a",
          session_id: "session-1",
          type: "SESSION_STARTED",
          display_label: "started a focus session",
          occurred_at: "2026-01-01T00:00:05.000Z",
        },
      ],
      error: null,
    });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await pollNewEventsForFriends(0);

    expect(result).toEqual({
      ok: true,
      events: [
        {
          id: "event-1",
          userId: "user-a",
          sessionId: "session-1",
          type: "SESSION_STARTED",
          displayLabel: "started a focus session",
          occurredAt: new Date("2026-01-01T00:00:05.000Z").getTime(),
        },
      ],
    });
  });

  it("returns ok: true with events: [] when there is no authenticated session (a legitimate empty state, not a failure to retry)", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await pollNewEventsForFriends(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, events: [] });
  });

  it("returns ok: false (distinct from a genuine empty result) on a query error, and does not throw", async () => {
    mockSignedIn("user-b");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollNewEventsForFriends(0);

    expect(result).toEqual({ ok: false, events: [] });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("returns ok: false when getSession itself throws, and does not throw", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollNewEventsForFriends(0);

    expect(result).toEqual({ ok: false, events: [] });
  });

  it("returns ok: false when getSession resolves with an explicit error (not thrown)", async () => {
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: { message: "invalid refresh token" },
    } as never);
    const fromSpy = vi.spyOn(supabase, "from");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollNewEventsForFriends(0);

    // An explicit auth error is a real failure, not "cleanly signed out" - must not be
    // conflated with the ok:true/no-session case above, and must not proceed to query the table.
    expect(result).toEqual({ ok: false, events: [] });
    expect(fromSpy).not.toHaveBeenCalled();
  });

  // v2 Task 10 regression test: proves the baseline friend-events fetch never requests
  // hostname/goal_text, regardless of any friendship_settings toggle's state - this is a
  // client-side proof to go alongside verify-privacy-controls.mjs's live proof that a bare
  // `.select()` would silently leak these two fields to everyone who can see the row at all,
  // bypassing the new per-field toggles entirely (see BASELINE_EVENT_COLUMNS's comment in
  // sessionStatusSyncApi.ts).
  it("never requests hostname/goal_text - selects only the fixed baseline column list, regardless of toggle state", async () => {
    mockSignedIn("user-b");
    const builder = makeBuilder({ data: [], error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await pollNewEventsForFriends(0);

    expect(builder.select).toHaveBeenCalledTimes(1);
    const selectArg = builder.select.mock.calls[0]![0] as string;
    expect(selectArg).toBe("id, user_id, session_id, type, display_label, occurred_at");
    expect(selectArg).not.toContain("hostname");
    expect(selectArg).not.toContain("goal_text");
  });
});

describe("sessionStatusSyncApi.fetchFriendEventDetails (v2 Task 10)", () => {
  it("calls the fetch_friend_event_details RPC with the given event ids and maps the result to camelCase", async () => {
    const rpcSpy = vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: [{ id: "event-1", hostname: "youtube.com", goal_text: "Finish chapter 6" }],
      error: null,
    } as never);

    const result = await fetchFriendEventDetails(["event-1"]);

    expect(rpcSpy).toHaveBeenCalledWith("fetch_friend_event_details", {
      p_event_ids: ["event-1"],
    });
    expect(result).toEqual([
      { id: "event-1", hostname: "youtube.com", goalText: "Finish chapter 6" },
    ]);
  });

  it("returns [] without calling the RPC when given an empty id list", async () => {
    const rpcSpy = vi.spyOn(supabase, "rpc");

    const result = await fetchFriendEventDetails([]);

    expect(rpcSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) when the RPC errors", async () => {
    vi.spyOn(supabase, "rpc").mockResolvedValue({ data: null, error: { message: "boom" } } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchFriendEventDetails(["event-1"]);

    expect(result).toEqual([]);
  });
});

describe("sessionStatusSyncApi.fetchFriendInterventionCount (v2 Task 10)", () => {
  it("calls the fetch_friend_intervention_count RPC and returns the count", async () => {
    const rpcSpy = vi.spyOn(supabase, "rpc").mockResolvedValue({ data: 3, error: null } as never);

    const result = await fetchFriendInterventionCount("user-a");

    expect(rpcSpy).toHaveBeenCalledWith("fetch_friend_intervention_count", {
      p_subject_user_id: "user-a",
      p_since: null,
    });
    expect(result).toBe(3);
  });

  it("passes `since` as an ISO timestamp when given", async () => {
    const rpcSpy = vi.spyOn(supabase, "rpc").mockResolvedValue({ data: 0, error: null } as never);
    const since = new Date("2026-01-01T00:00:00.000Z").getTime();

    await fetchFriendInterventionCount("user-a", since);

    expect(rpcSpy).toHaveBeenCalledWith("fetch_friend_intervention_count", {
      p_subject_user_id: "user-a",
      p_since: new Date(since).toISOString(),
    });
  });

  it("returns null (not 0, not throw) when the RPC denies/errors - distinguishable from a real zero count", async () => {
    vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: null,
      error: { message: "Not authorized to view this user's intervention count" },
    } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchFriendInterventionCount("user-a");

    expect(result).toBeNull();
  });
});

describe("sessionStatusSyncApi.fetchFriendFullHistory (v2 Task 10)", () => {
  it("calls the fetch_friend_full_history RPC and maps every row to camelCase", async () => {
    const rpcSpy = vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: [
        {
          id: "event-1",
          user_id: "user-a",
          session_id: "session-1",
          type: "SESSION_STARTED",
          display_label: "started a focus session",
          hostname: null,
          goal_text: "Finish chapter 6",
          occurred_at: "2026-01-01T00:00:05.000Z",
        },
      ],
      error: null,
    } as never);

    const result = await fetchFriendFullHistory("user-a");

    expect(rpcSpy).toHaveBeenCalledWith("fetch_friend_full_history", {
      p_subject_user_id: "user-a",
    });
    expect(result).toEqual([
      {
        id: "event-1",
        userId: "user-a",
        sessionId: "session-1",
        type: "SESSION_STARTED",
        displayLabel: "started a focus session",
        hostname: null,
        goalText: "Finish chapter 6",
        occurredAt: new Date("2026-01-01T00:00:05.000Z").getTime(),
      },
    ]);
  });

  it("returns [] (does not throw) when the RPC denies/errors", async () => {
    vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: null,
      error: { message: "Not authorized to view this user's full session history" },
    } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchFriendFullHistory("user-a");

    expect(result).toEqual([]);
  });
});
