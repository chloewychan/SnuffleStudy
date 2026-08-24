import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import { getMyProfile, saveMyProfile, fetchProfilesByIds } from "./profileApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// friendGroupApi.test.ts/friendshipSettingsApi.test.ts - nothing here ever lets the real client
// make a network call.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors friendshipSettingsApi.test.ts's
// makeBuilder, plus `.upsert()`/`.in()` for this file's own calls.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    select: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    in: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    select: vi.fn(),
    upsert: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.select.mockReturnValue(builder);
  builder.upsert.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  return builder;
}

function mockSignedIn(userId: string) {
  return vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  } as never);
}

function mockSignedOut() {
  return vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
    data: { user: null },
    error: null,
  } as never);
}

const sampleRow = {
  user_id: "user-a",
  human_name: "Alice",
  bunny_name: "Fluffball",
  updated_at: "2026-01-01T00:00:00Z",
};

const sampleProfile = {
  userId: "user-a",
  humanName: "Alice",
  bunnyName: "Fluffball",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("profileApi.getMyProfile", () => {
  it("selects the caller's own row using maybeSingle (null, not an error, when absent)", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await getMyProfile();

    expect(fromSpy).toHaveBeenCalledWith("profiles");
    expect(builder.eq).toHaveBeenCalledWith("user_id", "user-a");
    expect(builder.maybeSingle).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("returns the mapped row when it exists", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(makeBuilder({ data: sampleRow, error: null }) as never);

    const result = await getMyProfile();

    expect(result).toEqual(sampleProfile);
  });

  it("throws when not signed in, without touching the database", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(getMyProfile()).rejects.toThrow(/not signed in/i);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws with the underlying error message on a query failure", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );

    await expect(getMyProfile()).rejects.toThrow("boom");
  });
});

describe("profileApi.saveMyProfile", () => {
  it("upserts only the given patch fields (camelCase -> snake_case) plus the caller's own user_id", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await saveMyProfile({ humanName: "Alice", bunnyName: "Fluffball" });

    expect(fromSpy).toHaveBeenCalledWith("profiles");
    expect(builder.upsert).toHaveBeenCalledWith(
      { user_id: "user-a", human_name: "Alice", bunny_name: "Fluffball" },
      { onConflict: "user_id" }
    );
    expect(builder.single).toHaveBeenCalled();
    expect(result).toEqual(sampleProfile);
  });

  it("omits an unset field from the upsert payload rather than writing it as undefined/null", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await saveMyProfile({ humanName: "Alice" });

    expect(builder.upsert).toHaveBeenCalledWith(
      { user_id: "user-a", human_name: "Alice" },
      { onConflict: "user_id" }
    );
  });

  it("never writes under anyone else's identity - user_id always comes from requireUserId(), never the patch", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await saveMyProfile({ humanName: "Alice" });

    const [payload] = builder.upsert.mock.calls[0] as [Record<string, unknown>];
    expect(payload.user_id).toBe("user-a");
  });

  it("throws on an upsert failure", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );

    await expect(saveMyProfile({ humanName: "Alice" })).rejects.toThrow("boom");
  });

  it("throws when not signed in, without touching the database", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(saveMyProfile({ humanName: "Alice" })).rejects.toThrow(/not signed in/i);
    expect(fromSpy).not.toHaveBeenCalled();
  });
});

describe("profileApi.fetchProfilesByIds", () => {
  it("does a plain select().in(user_id, userIds), relying entirely on RLS to filter the result", async () => {
    const builder = makeBuilder({ data: [sampleRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await fetchProfilesByIds(["user-a", "user-stranger"]);

    expect(fromSpy).toHaveBeenCalledWith("profiles");
    expect(builder.in).toHaveBeenCalledWith("user_id", ["user-a", "user-stranger"]);
    // Only user-a's row came back (RLS silently omitted user-stranger's, per the mocked result) -
    // this function does no client-side filtering of its own to compensate or explain that.
    expect(result).toEqual([sampleProfile]);
  });

  it("returns [] immediately for an empty id list, without querying the database", async () => {
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await fetchProfilesByIds([]);

    expect(result).toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("degrades to [] (never throws) on a query error - same convention as fetchRelevantUnlockRequests", async () => {
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchProfilesByIds(["user-a"]);

    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("degrades to [] (never throws) when the query itself throws", async () => {
    vi.spyOn(supabase, "from").mockImplementation(() => {
      throw new Error("network down");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchProfilesByIds(["user-a"]);

    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("does NOT require sign-in - fetchProfilesByIds never calls requireUserId()", async () => {
    mockSignedOut();
    const builder = makeBuilder({ data: [sampleRow], error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    // Would throw "Not signed in." if this function called requireUserId() the way
    // getMyProfile/saveMyProfile do - it deliberately doesn't, since a signed-out caller (and
    // more importantly a caller not yet resolved) should still degrade to [], not throw.
    const result = await fetchProfilesByIds(["user-a"]);

    expect(result).toEqual([sampleProfile]);
  });
});
