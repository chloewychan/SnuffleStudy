import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import { sendNudge, fetchIncomingNudges, pollIncomingNudges } from "./nudgeApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// sessionStatusSyncApi.test.ts/friendGroupApi.test.ts.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors sessionStatusSyncApi.test.ts's
// makeBuilder.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    insert: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    gt: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    insert: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    gt: vi.fn(),
    order: vi.fn(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.insert.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
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

describe("nudgeApi.sendNudge", () => {
  it("inserts a nudges row for the current user as sender, targeting the given friend/message", async () => {
    mockSignedIn("user-s");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await sendNudge("user-r", "keep-going");

    expect(fromSpy).toHaveBeenCalledWith("nudges");
    expect(builder.insert).toHaveBeenCalledWith({
      sender_user_id: "user-s",
      recipient_user_id: "user-r",
      message_id: "keep-going",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects client-side (without touching the database) when messageId isn't in the predefined catalog", async () => {
    mockSignedIn("user-s");
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await sendNudge("user-r", "not-a-real-message");

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns ok:false with a friendly message (not the raw Postgres error) when the RLS INSERT policy denies the send", async () => {
    mockSignedIn("user-s");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({
        data: null,
        error: { message: 'new row violates row-level security policy for table "nudges"' },
      }) as never
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendNudge("user-r", "keep-going");

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain("row-level security");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("returns ok:false when not signed in, without touching the database", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await sendNudge("user-r", "keep-going");

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: expect.any(String) });
  });

  it("returns ok:false (does not throw) when the auth check itself fails", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("boom"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendNudge("user-r", "keep-going");

    expect(result.ok).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("nudgeApi.fetchIncomingNudges", () => {
  it("selects nudges addressed to the current user, newer than sinceTimestamp, mapped to camelCase", async () => {
    mockSignedIn("user-r");
    const builder = makeBuilder({
      data: [
        {
          id: "nudge-1",
          sender_user_id: "user-s",
          recipient_user_id: "user-r",
          message_id: "keep-going",
          sent_at: "2026-01-01T00:00:05.000Z",
        },
      ],
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const since = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = await fetchIncomingNudges(since);

    expect(fromSpy).toHaveBeenCalledWith("nudges");
    expect(builder.eq).toHaveBeenCalledWith("recipient_user_id", "user-r");
    expect(builder.gt).toHaveBeenCalledWith("sent_at", new Date(since).toISOString());
    expect(result).toEqual([
      {
        id: "nudge-1",
        senderUserId: "user-s",
        recipientUserId: "user-r",
        messageId: "keep-going",
        sentAt: new Date("2026-01-01T00:00:05.000Z").getTime(),
      },
    ]);
  });

  it("returns [] when there is no authenticated session", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await fetchIncomingNudges(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a query error", async () => {
    mockSignedIn("user-r");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchIncomingNudges(0);

    expect(result).toEqual([]);
  });
});

// Fix-round-1 discipline from Task 6 (see sessionStatusSyncApi.ts's pollNewEventsForFriends
// comment), applied here from the start: alarmHandlers.ts's friend-poll alarm needs to
// distinguish "the fetch failed" from "genuinely no new nudges" so it only advances its
// persisted nudge cursor on confirmed success.
describe("nudgeApi.pollIncomingNudges", () => {
  it("returns ok: true with the mapped nudges on a successful query", async () => {
    mockSignedIn("user-r");
    const builder = makeBuilder({
      data: [
        {
          id: "nudge-1",
          sender_user_id: "user-s",
          recipient_user_id: "user-r",
          message_id: "keep-going",
          sent_at: "2026-01-01T00:00:05.000Z",
        },
      ],
      error: null,
    });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await pollIncomingNudges(0);

    expect(result).toEqual({
      ok: true,
      nudges: [
        {
          id: "nudge-1",
          senderUserId: "user-s",
          recipientUserId: "user-r",
          messageId: "keep-going",
          sentAt: new Date("2026-01-01T00:00:05.000Z").getTime(),
        },
      ],
    });
  });

  it("returns ok: true with nudges: [] when there is no authenticated session (a legitimate empty state, not a failure to retry)", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await pollIncomingNudges(0);

    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, nudges: [] });
  });

  it("returns ok: false (distinct from a genuine empty result) on a query error, and does not throw", async () => {
    mockSignedIn("user-r");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollIncomingNudges(0);

    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false when getSession itself throws, and does not throw", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollIncomingNudges(0);

    expect(result).toEqual({ ok: false });
  });
});
