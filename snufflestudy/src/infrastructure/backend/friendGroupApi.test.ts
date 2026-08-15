import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import { createGroup, generateInviteCode, joinGroup, listMembers } from "./friendGroupApi";

// Spies on the supabaseClient module's exported singleton (the actual boundary friendGroupApi.ts
// talks to in this codebase - mirrors this repo's existing style of vi.spyOn-ing an imported
// module's exports, e.g. OptionsApp.test.tsx spying on extensionMessenger's sendMessage,
// rather than vi.mock'ing the module). Nothing here ever lets the real client make a network
// call - every spied method's implementation is replaced before use.
beforeEach(() => {
  vi.restoreAllMocks();
});

// A minimal fake of supabase-js's PostgrestFilterBuilder: chainable methods that return the
// same builder, plus `.single()` (resolves immediately) and `.then()` (so `await builder` also
// works for chains that don't call `.single()`, e.g. listMembers's `.select().eq(...)`).
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    insert: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    insert: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    update: vi.fn(),
    single: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.insert.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  return builder;
}

describe("friendGroupApi.createGroup", () => {
  // createGroup does three calls in order: (1) a bare insert into friend_groups using a
  // client-generated id and no .select(), (2) an insert into group_memberships for the owner,
  // (3) a select().eq(id).single() to fetch the group back. Order (1) then (3) - rather than
  // insert-then-.select() on the same call - is deliberate: friend_groups' "members can read
  // their groups" RLS policy requires a group_memberships row to already exist for the reader,
  // and Postgres enforces that same SELECT policy against an INSERT's own RETURNING clause, not
  // just later reads - so .insert(...).select().single() on friend_groups would fail every
  // time (no group_memberships row exists yet at that instant). See the comment in
  // friendGroupApi.ts and supabase/migrations/20260815000003_v2_fix_grants_and_rls_recursion.sql.
  it("inserts into friend_groups with a locally-generated id, inserts the owner's membership row, then fetches the group back", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    const insertGroupBuilder = makeBuilder({ data: null, error: null });
    const insertMembershipBuilder = makeBuilder({ data: null, error: null });
    const fetchGroupBuilder = makeBuilder({
      data: {
        id: "group-1",
        name: "Study Buddies",
        owner_user_id: "user-a",
        created_at: "2026-01-01T00:00:00Z",
      },
      error: null,
    });
    let friendGroupsCallCount = 0;
    const fromSpy = vi.spyOn(supabase, "from").mockImplementation(((table: string) => {
      if (table === "friend_groups") {
        friendGroupsCallCount += 1;
        return friendGroupsCallCount === 1 ? insertGroupBuilder : fetchGroupBuilder;
      }
      if (table === "group_memberships") return insertMembershipBuilder;
      throw new Error(`unexpected table ${table}`);
    }) as never);

    const result = await createGroup("Study Buddies");

    expect(fromSpy).toHaveBeenNthCalledWith(1, "friend_groups");
    expect(insertGroupBuilder.insert).toHaveBeenCalledTimes(1);
    // No .select() chained on this call - see the describe-level comment above.
    expect(insertGroupBuilder.select).not.toHaveBeenCalled();
    const insertArg = insertGroupBuilder.insert.mock.calls[0]![0] as {
      id: string;
      name: string;
      owner_user_id: string;
    };
    expect(insertArg.name).toBe("Study Buddies");
    expect(insertArg.owner_user_id).toBe("user-a");
    expect(insertArg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // The owner must be a member of their own group, or friend_groups' "members can read their
    // groups" RLS policy would never let them read it back (see
    // supabase/migrations/20260815000002_v2_rls_policies.sql).
    expect(fromSpy).toHaveBeenNthCalledWith(2, "group_memberships");
    expect(insertMembershipBuilder.insert).toHaveBeenCalledWith({
      group_id: insertArg.id,
      user_id: "user-a",
    });

    expect(fromSpy).toHaveBeenNthCalledWith(3, "friend_groups");
    expect(fetchGroupBuilder.eq).toHaveBeenCalledWith("id", insertArg.id);
    expect(result).toEqual({
      id: "group-1",
      name: "Study Buddies",
      ownerUserId: "user-a",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("throws when not signed in, without touching the database", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: null },
      error: null,
    } as never);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(createGroup("x")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws the Postgres error message when the friend_groups insert fails", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "insert failed" } }) as never
    );

    await expect(createGroup("x")).rejects.toThrow("insert failed");
  });

  it("throws when the group_memberships insert fails", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    const insertGroupBuilder = makeBuilder({ data: null, error: null });
    const membershipBuilder = makeBuilder({ data: null, error: { message: "membership failed" } });
    vi.spyOn(supabase, "from").mockImplementation(((table: string) =>
      table === "friend_groups" ? insertGroupBuilder : membershipBuilder) as never);

    await expect(createGroup("x")).rejects.toThrow("membership failed");
  });

  it("throws when the post-insert fetch fails", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    const insertGroupBuilder = makeBuilder({ data: null, error: null });
    const insertMembershipBuilder = makeBuilder({ data: null, error: null });
    const fetchGroupBuilder = makeBuilder({ data: null, error: { message: "fetch failed" } });
    let friendGroupsCallCount = 0;
    vi.spyOn(supabase, "from").mockImplementation(((table: string) => {
      if (table === "friend_groups") {
        friendGroupsCallCount += 1;
        return friendGroupsCallCount === 1 ? insertGroupBuilder : fetchGroupBuilder;
      }
      return insertMembershipBuilder;
    }) as never);

    await expect(createGroup("x")).rejects.toThrow("fetch failed");
  });
});

describe("friendGroupApi.generateInviteCode", () => {
  it("inserts a short alphanumeric code into invite_codes, scoped to the group and current user, with a future expiry", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    const builder = makeBuilder({
      data: {
        code: "ABCD1234",
        group_id: "group-1",
        created_by: "user-a",
        expires_at: "2026-01-08T00:00:00Z",
        used_by: null,
      },
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await generateInviteCode("group-1");

    expect(fromSpy).toHaveBeenCalledWith("invite_codes");
    expect(builder.insert).toHaveBeenCalledTimes(1);
    const insertArg = builder.insert.mock.calls[0]![0] as {
      code: string;
      group_id: string;
      created_by: string;
      expires_at: string;
    };
    expect(insertArg.group_id).toBe("group-1");
    expect(insertArg.created_by).toBe("user-a");
    expect(insertArg.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(new Date(insertArg.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(result).toEqual({
      code: "ABCD1234",
      groupId: "group-1",
      createdBy: "user-a",
      expiresAt: "2026-01-08T00:00:00Z",
      usedBy: null,
    });
  });

  it("throws when the insert fails", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "insert failed" } }) as never
    );

    await expect(generateInviteCode("group-1")).rejects.toThrow("insert failed");
  });
});

describe("friendGroupApi.joinGroup", () => {
  it("looks up the invite code, redeems it, THEN inserts the membership row (in that order)", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-b" } },
      error: null,
    } as never);
    const lookupBuilder = makeBuilder({
      data: { code: "CODE1234", group_id: "group-1" },
      error: null,
    });
    const insertBuilder = makeBuilder({
      data: { group_id: "group-1", user_id: "user-b", joined_at: "2026-01-02T00:00:00Z" },
      error: null,
    });
    const updateBuilder = makeBuilder({ data: null, error: null });
    // Tracks the order tables were touched in, so the test can assert redemption happens
    // BEFORE the membership insert - not just that both happened. This order is load-bearing
    // (fix round 1): group_memberships' INSERT policy (supabase/migrations/
    // 20260815000005_v2_gate_group_membership_on_invite.sql) requires a matching invite_codes
    // row with used_by = auth.uid() to already exist, so redeeming after inserting membership
    // would leave that check with nothing to find.
    const callOrder: string[] = [];
    let inviteCodesCallCount = 0;
    vi.spyOn(supabase, "from").mockImplementation(((table: string) => {
      if (table === "invite_codes") {
        inviteCodesCallCount += 1;
        if (inviteCodesCallCount === 1) {
          callOrder.push("invite_codes:lookup");
          return lookupBuilder;
        }
        callOrder.push("invite_codes:redeem");
        return updateBuilder;
      }
      if (table === "group_memberships") {
        callOrder.push("group_memberships:insert");
        return insertBuilder;
      }
      throw new Error(`unexpected table ${table}`);
    }) as never);

    const result = await joinGroup("CODE1234");

    expect(callOrder).toEqual([
      "invite_codes:lookup",
      "invite_codes:redeem",
      "group_memberships:insert",
    ]);
    expect(lookupBuilder.eq).toHaveBeenCalledWith("code", "CODE1234");
    expect(insertBuilder.insert).toHaveBeenCalledWith({ group_id: "group-1", user_id: "user-b" });
    // Redeeming must run as the joining user's own session - invite_codes' "unused unexpired
    // codes can be redeemed once" RLS policy's WITH CHECK requires used_by = auth.uid().
    expect(updateBuilder.update).toHaveBeenCalledWith({ used_by: "user-b" });
    expect(updateBuilder.eq).toHaveBeenCalledWith("code", "CODE1234");
    expect(result).toEqual({
      groupId: "group-1",
      userId: "user-b",
      joinedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("throws when redeeming the code fails, without attempting the membership insert", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-b" } },
      error: null,
    } as never);
    const lookupBuilder = makeBuilder({
      data: { code: "CODE1234", group_id: "group-1" },
      error: null,
    });
    const updateBuilder = makeBuilder({ data: null, error: { message: "redeem failed" } });
    const insertBuilder = makeBuilder({ data: null, error: null });
    let inviteCodesCallCount = 0;
    const fromSpy = vi.spyOn(supabase, "from").mockImplementation(((table: string) => {
      if (table === "invite_codes") {
        inviteCodesCallCount += 1;
        return inviteCodesCallCount === 1 ? lookupBuilder : updateBuilder;
      }
      return insertBuilder;
    }) as never);

    await expect(joinGroup("CODE1234")).rejects.toThrow("redeem failed");
    expect(fromSpy).not.toHaveBeenCalledWith("group_memberships");
  });

  it("throws a clear error when the code isn't found (covers not-found, expired, and already-used - RLS filters all three identically)", async () => {
    vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
      data: { user: { id: "user-b" } },
      error: null,
    } as never);
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "no rows" } }) as never
    );

    await expect(joinGroup("BADCODE")).rejects.toThrow(/not found, expired, or already used/i);
  });
});

describe("friendGroupApi.listMembers", () => {
  it("selects group_memberships filtered by group id and maps rows to camelCase", async () => {
    const builder = makeBuilder({
      data: [
        { group_id: "group-1", user_id: "user-a", joined_at: "2026-01-01T00:00:00Z" },
        { group_id: "group-1", user_id: "user-b", joined_at: "2026-01-02T00:00:00Z" },
      ],
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await listMembers("group-1");

    expect(fromSpy).toHaveBeenCalledWith("group_memberships");
    expect(builder.eq).toHaveBeenCalledWith("group_id", "group-1");
    expect(result).toEqual([
      { groupId: "group-1", userId: "user-a", joinedAt: "2026-01-01T00:00:00Z" },
      { groupId: "group-1", userId: "user-b", joinedAt: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("throws on a query error", async () => {
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );

    await expect(listMembers("group-1")).rejects.toThrow("boom");
  });
});
