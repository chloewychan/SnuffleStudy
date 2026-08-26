import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import { generateInviteCode, redeemInviteCode, listMyFriends, removeFriend } from "./friendshipApi";

// v3.4 Task 2: replaces friendGroupApi.test.ts entirely - the group mechanic is gone, replaced by
// a direct pairwise friendships table (supabase/migrations/20260815000040_v3.4_friendships.sql).
// Spies on the supabaseClient module's exported singleton (the actual boundary friendshipApi.ts
// talks to in this codebase - mirrors this repo's existing style of vi.spyOn-ing an imported
// module's exports rather than vi.mock'ing the module). Nothing here ever lets the real client
// make a network call - every spied method's implementation is replaced before use.
beforeEach(() => {
  vi.restoreAllMocks();
});

// A minimal fake of supabase-js's PostgrestFilterBuilder: chainable methods that return the same
// builder, plus `.single()` (resolves immediately) and `.then()` (so `await builder` also works
// for chains that don't call `.single()`, e.g. listMyFriends's `.select().or(...)`).
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    insert: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    or: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    insert: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    delete: vi.fn(),
    single: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.insert.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.or.mockReturnValue(builder);
  builder.delete.mockReturnValue(builder);
  return builder;
}

describe("friendshipApi.generateInviteCode", () => {
  it("inserts a short alphanumeric code into invite_codes, scoped only to the current user (no groupId - Decision 2), with a future expiry", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    const builder = makeBuilder({
      data: {
        code: "ABCD1234",
        created_by: "user-a",
        expires_at: "2026-01-08T00:00:00Z",
        used_by: null,
      },
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await generateInviteCode();

    expect(fromSpy).toHaveBeenCalledWith("invite_codes");
    expect(builder.insert).toHaveBeenCalledTimes(1);
    const insertArg = builder.insert.mock.calls[0]![0] as {
      code: string;
      created_by: string;
      expires_at: string;
    };
    expect(insertArg.created_by).toBe("user-a");
    expect(insertArg.code).toMatch(/^[A-Z0-9]{8}$/);
    expect((insertArg as Record<string, unknown>).group_id).toBeUndefined();
    expect(new Date(insertArg.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(result).toEqual({
      code: "ABCD1234",
      createdBy: "user-a",
      expiresAt: new Date("2026-01-08T00:00:00Z").getTime(),
      usedBy: null,
    });
  });

  it("throws when not signed in, without touching the database", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: null },
      error: null,
    } as never);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(generateInviteCode()).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws the Postgres error message when the insert fails", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "insert failed" } }) as never
    );

    await expect(generateInviteCode()).rejects.toThrow("insert failed");
  });
});

// redeemInviteCode makes ONE redeem_invite_code RPC call - the lookup/redemption/friendships
// insert all happen inside that SECURITY DEFINER function as a single transaction (supabase/
// migrations/20260815000040_v3.4_friendships.sql). Under the pairwise model this creates a
// friendships row directly between the two users (Decision 1: instant connect, no accept/decline
// step) instead of a group_memberships row.
describe("friendshipApi.redeemInviteCode", () => {
  it("redeems the code via the redeem_invite_code RPC and never touches invite_codes/friendships directly", async () => {
    // The RPC is `returns friendships` (a single composite row), not `returns setof`/
    // `returns table`, so PostgREST hands back one JSON object rather than an array.
    const rpcSpy = vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: {
        user_id_a: "user-a",
        user_id_b: "user-b",
        initiated_by: "user-a",
        created_at: "2026-01-02T00:00:00Z",
      },
      error: null,
    } as never);
    const fromSpy = vi.spyOn(supabase, "from");

    const result = await redeemInviteCode("CODE1234");

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith("redeem_invite_code", { p_code: "CODE1234" });
    expect(fromSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      userIdA: "user-a",
      userIdB: "user-b",
      initiatedBy: "user-a",
      createdAt: new Date("2026-01-02T00:00:00Z").getTime(),
    });
  });

  it("surfaces the RPC's own exception message (covers not-found, expired, already-used, and self-redemption - the function raises for all four)", async () => {
    vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: null,
      error: { message: "Invite code not found, expired, or already used." },
    } as never);

    await expect(redeemInviteCode("BADCODE")).rejects.toThrow(/not found, expired, or already used/i);
  });

  it("throws when the RPC returns no row and no error, rather than returning a half-built friendship", async () => {
    vi.spyOn(supabase, "rpc").mockResolvedValue({ data: null, error: null } as never);

    await expect(redeemInviteCode("CODE1234")).rejects.toThrow(
      /could not redeem that invite code/i
    );
  });
});

describe("friendshipApi.listMyFriends", () => {
  it("selects friendships where the current user is either party, and maps to the OTHER user's id", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    const builder = makeBuilder({
      data: [
        { user_id_a: "user-a", user_id_b: "user-b" },
        { user_id_a: "user-c", user_id_b: "user-a" },
      ],
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await listMyFriends();

    expect(fromSpy).toHaveBeenCalledWith("friendships");
    expect(builder.or).toHaveBeenCalledWith("user_id_a.eq.user-a,user_id_b.eq.user-a");
    // Self never appears - only the OTHER id from each row.
    expect(result).toEqual(["user-b", "user-c"]);
  });

  it("throws when not signed in, without touching the database", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: null },
      error: null,
    } as never);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(listMyFriends()).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws on a query error", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );

    await expect(listMyFriends()).rejects.toThrow("boom");
  });
});

// "Remove friend" - either party can unilaterally end the friendship (RLS: "either party can
// remove their friendship"), so removeFriend does no authorization of its own - these tests only
// cover what it itself controls: canonical ordering of the composite key, and the zero-rows guard.
describe("friendshipApi.removeFriend", () => {
  it("deletes the friendships row using canonical (a < b) ordering regardless of which id is the caller's", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-b" } },
      error: null,
    } as never);
    const builder = makeBuilder({
      data: [{ user_id_a: "user-a", user_id_b: "user-b" }],
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await removeFriend("user-a");

    expect(fromSpy).toHaveBeenCalledWith("friendships");
    expect(builder.delete).toHaveBeenCalledTimes(1);
    // "user-a" < "user-b" lexicographically, so user_id_a stays "user-a" regardless of which one
    // is the caller.
    expect(builder.eq).toHaveBeenCalledWith("user_id_a", "user-a");
    expect(builder.eq).toHaveBeenCalledWith("user_id_b", "user-b");
    expect(builder.select).toHaveBeenCalledTimes(1);
  });

  it("throws when not signed in, without touching the database", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: null },
      error: null,
    } as never);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(removeFriend("user-a")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws the Postgres error message when the delete fails", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "delete failed" } }) as never
    );

    await expect(removeFriend("user-b")).rejects.toThrow("delete failed");
  });

  // A bare `.delete()` with no `.select()` can't distinguish "row actually removed" from "RLS
  // silently filtered to zero rows" (e.g. the two users were never actually friends). Postgres/
  // PostgREST report that as a *successful* delete of zero rows, not an error - `error` is null
  // and `data` is `[]` - so this case is deliberately distinct from the "delete fails" test above.
  it("throws a clear error when the delete affects zero rows (RLS silently filtered it out)", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    const builder = makeBuilder({ data: [], error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await expect(removeFriend("user-stranger")).rejects.toThrow(
      "You aren't friends with this user."
    );
    expect(builder.select).toHaveBeenCalledTimes(1);
  });
});
