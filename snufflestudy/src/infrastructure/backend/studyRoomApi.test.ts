import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import {
  createRoom,
  listRooms,
  joinRoom,
  leaveRoom,
  listParticipants,
  subscribeToPresence,
  archiveRoom,
  addInvitee,
  removeInvitee,
  listInvitees,
} from "./studyRoomApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// unlockRequestApi.test.ts/nudgeApi.test.ts.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors unlockRequestApi.test.ts's
// makeBuilder, extended with `is` since leaveRoom/listParticipants use it.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    is: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    single: vi.fn(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.insert.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  builder.delete.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.is.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.single.mockReturnValue(builder);
  return builder;
}

function mockGetUser(userId: string | null) {
  return vi.spyOn(supabase.auth, "getUser").mockResolvedValue(
    (userId
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: { message: "Not signed in." } }) as never
  );
}

// supabase-js's SupabaseClient.functions is a GETTER that constructs a brand-new FunctionsClient
// on every access - mirrors tempPasscodeApi.test.ts's/coachingApi.test.ts's identical mockInvoke
// helper (spying on `supabase.functions.invoke` directly would silently miss the real call, since
// studyRoomApi.ts reads the getter again and gets a different instance).
function mockInvoke(impl: (...args: unknown[]) => Promise<unknown>) {
  const invokeMock = vi.fn(impl);
  vi.spyOn(supabase, "functions", "get").mockReturnValue({ invoke: invokeMock } as never);
  return invokeMock;
}

const sampleRoomRow = {
  id: "room-1",
  name: "Thursday study group",
  owner_user_id: "user-a",
  created_at: "2026-01-01T00:00:00.000Z",
};

const sampleParticipantRow = {
  room_id: "room-1",
  user_id: "user-b",
  joined_at: "2026-01-01T00:05:00.000Z",
  left_at: null,
};

describe("studyRoomApi.createRoom", () => {
  it("inserts a study_rooms row owned by the current user, and returns the mapped result", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: sampleRoomRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await createRoom("Thursday study group");

    expect(fromSpy).toHaveBeenCalledWith("study_rooms");
    expect(builder.insert).toHaveBeenCalledWith({
      name: "Thursday study group",
      owner_user_id: "user-a",
    });
    expect(result).toEqual({
      id: "room-1",
      name: "Thursday study group",
      ownerUserId: "user-a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(createRoom("Thursday study group")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws with the Postgres error message when the insert is denied", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "new row violates row-level security policy" } }) as never
    );

    await expect(createRoom("Thursday study group")).rejects.toThrow(
      "new row violates row-level security policy"
    );
  });
});

describe("studyRoomApi.listRooms", () => {
  it("returns every room RLS hands back, mapped, without any extra client-side filtering", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: [sampleRoomRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await listRooms();

    expect(fromSpy).toHaveBeenCalledWith("study_rooms");
    expect(builder.is).toHaveBeenCalledWith("archived_at", null);
    expect(builder.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(result).toEqual([
      {
        id: "room-1",
        name: "Thursday study group",
        ownerUserId: "user-a",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});

describe("studyRoomApi.joinRoom", () => {
  it("inserts the caller's own participant row, then mints and returns a LiveKit token", async () => {
    mockGetUser("user-b");
    const insertBuilder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(insertBuilder as never);
    const invokeMock = mockInvoke(() => Promise.resolve({ data: { token: "livekit-jwt" }, error: null }));

    const result = await joinRoom("room-1");

    expect(fromSpy).toHaveBeenCalledWith("study_room_participants");
    expect(insertBuilder.insert).toHaveBeenCalledWith({ room_id: "room-1", user_id: "user-b" });
    expect(invokeMock).toHaveBeenCalledWith("generate-livekit-token", { body: { roomId: "room-1" } });
    expect(result).toEqual({ token: "livekit-jwt" });
  });

  it("throws (without ever invoking generate-livekit-token) when the participant insert is denied", async () => {
    mockGetUser("user-c");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "new row violates row-level security policy" } }) as never
    );
    const invokeMock = mockInvoke(() => Promise.resolve({ data: { token: "x" }, error: null }));

    await expect(joinRoom("room-1")).rejects.toThrow("new row violates row-level security policy");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("throws when the participant insert succeeds but token minting fails", async () => {
    mockGetUser("user-b");
    vi.spyOn(supabase, "from").mockReturnValue(makeBuilder({ data: null, error: null }) as never);
    mockInvoke(() => Promise.resolve({ data: null, error: { message: "Not a participant of this room" } }));

    await expect(joinRoom("room-1")).rejects.toThrow("Not a participant of this room");
  });
});

describe("studyRoomApi.leaveRoom", () => {
  it("sets left_at on the caller's currently-open participant row for this room", async () => {
    mockGetUser("user-b");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await leaveRoom("room-1");

    expect(fromSpy).toHaveBeenCalledWith("study_room_participants");
    expect(builder.update).toHaveBeenCalledWith({ left_at: expect.any(String) });
    expect(builder.eq).toHaveBeenCalledWith("room_id", "room-1");
    expect(builder.eq).toHaveBeenCalledWith("user_id", "user-b");
    expect(builder.is).toHaveBeenCalledWith("left_at", null);
  });

  it("throws with the Postgres error message when the update fails", async () => {
    mockGetUser("user-b");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "update failed" } }) as never
    );

    await expect(leaveRoom("room-1")).rejects.toThrow("update failed");
  });
});

describe("studyRoomApi.archiveRoom", () => {
  it("sets archived_at on a room the caller owns", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await archiveRoom("room-1");

    expect(fromSpy).toHaveBeenCalledWith("study_rooms");
    expect(builder.update).toHaveBeenCalledWith({ archived_at: expect.any(String) });
    expect(builder.eq).toHaveBeenCalledWith("id", "room-1");
    expect(builder.eq).toHaveBeenCalledWith("owner_user_id", "user-a");
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(archiveRoom("room-1")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws with the Postgres error message when the update fails", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "update failed" } }) as never
    );

    await expect(archiveRoom("room-1")).rejects.toThrow("update failed");
  });
});

describe("studyRoomApi.listParticipants", () => {
  it("returns currently-open participant rows (left_at is null) for a room, mapped", async () => {
    const builder = makeBuilder({ data: [sampleParticipantRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await listParticipants("room-1");

    expect(fromSpy).toHaveBeenCalledWith("study_room_participants");
    expect(builder.eq).toHaveBeenCalledWith("room_id", "room-1");
    expect(builder.is).toHaveBeenCalledWith("left_at", null);
    expect(result).toEqual([
      { roomId: "room-1", userId: "user-b", joinedAt: "2026-01-01T00:05:00.000Z", leftAt: null },
    ]);
  });
});

const sampleInviteeRow = {
  room_id: "room-1",
  user_id: "user-b",
  invited_by: "user-a",
  invited_at: "2026-01-01T00:00:00.000Z",
};

describe("studyRoomApi.addInvitee", () => {
  it("inserts a study_room_invitees row with invited_by set to the caller's own id", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await addInvitee("room-1", "user-b");

    expect(fromSpy).toHaveBeenCalledWith("study_room_invitees");
    expect(builder.insert).toHaveBeenCalledWith({
      room_id: "room-1",
      user_id: "user-b",
      invited_by: "user-a",
    });
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(addInvitee("room-1", "user-b")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws with the Postgres error message when the insert is denied (not the room's owner)", async () => {
    mockGetUser("user-c");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "new row violates row-level security policy" } }) as never
    );

    await expect(addInvitee("room-1", "user-b")).rejects.toThrow(
      "new row violates row-level security policy"
    );
  });
});

describe("studyRoomApi.removeInvitee", () => {
  it("deletes the study_room_invitees row for the given room/user pair", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await removeInvitee("room-1", "user-b");

    expect(fromSpy).toHaveBeenCalledWith("study_room_invitees");
    expect(builder.eq).toHaveBeenCalledWith("room_id", "room-1");
    expect(builder.eq).toHaveBeenCalledWith("user_id", "user-b");
  });

  it("throws with the Postgres error message when the delete fails", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "delete failed" } }) as never
    );

    await expect(removeInvitee("room-1", "user-b")).rejects.toThrow("delete failed");
  });
});

describe("studyRoomApi.listInvitees", () => {
  it("returns every invitee row RLS hands back for a room, mapped", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: [sampleInviteeRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await listInvitees("room-1");

    expect(fromSpy).toHaveBeenCalledWith("study_room_invitees");
    expect(builder.eq).toHaveBeenCalledWith("room_id", "room-1");
    expect(result).toEqual([
      { roomId: "room-1", userId: "user-b", invitedBy: "user-a", invitedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("throws when not signed in, without touching the database", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(listInvitees("room-1")).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
  });
});

// Fake of supabase-js's RealtimeChannel - just enough surface for subscribeToPresence's
// .channel(...).on("postgres_changes", filter, callback).subscribe() chain, and captures the
// registered callback so tests can simulate an incoming change event directly.
function makeFakeChannel() {
  let capturedCallback: ((payload: unknown) => void) | null = null;
  const channel = {
    on: vi.fn((_type: string, _filter: unknown, callback: (payload: unknown) => void) => {
      capturedCallback = callback;
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };
  return { channel, getCallback: () => capturedCallback };
}

describe("studyRoomApi.subscribeToPresence", () => {
  it("subscribes to postgres_changes for this room's participant rows, and maps events through onChange", () => {
    const { channel, getCallback } = makeFakeChannel();
    const channelSpy = vi.spyOn(supabase, "channel").mockReturnValue(channel as never);
    const removeChannelSpy = vi.spyOn(supabase, "removeChannel").mockReturnValue(undefined as never);

    const onChange = vi.fn();
    const unsubscribe = subscribeToPresence("room-1", onChange);

    expect(channelSpy).toHaveBeenCalledWith("study-room-presence-room-1");
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      { event: "*", schema: "public", table: "study_room_participants", filter: "room_id=eq.room-1" },
      expect.any(Function)
    );
    expect(channel.subscribe).toHaveBeenCalled();

    // Simulate a live INSERT event arriving over the (fake) Realtime WebSocket.
    const callback = getCallback();
    expect(callback).not.toBeNull();
    callback!({
      eventType: "INSERT",
      new: sampleParticipantRow,
      old: {},
      schema: "public",
      table: "study_room_participants",
      commit_timestamp: "2026-01-01T00:05:00.000Z",
      errors: [],
    });

    expect(onChange).toHaveBeenCalledWith({
      eventType: "INSERT",
      participant: {
        roomId: "room-1",
        userId: "user-b",
        joinedAt: "2026-01-01T00:05:00.000Z",
        leftAt: null,
      },
    });

    // Unsubscribing tears the channel down via removeChannel, not just channel.unsubscribe() -
    // see studyRoomApi.ts's own comment on why.
    unsubscribe();
    expect(removeChannelSpy).toHaveBeenCalledWith(channel);
  });

  it("maps a DELETE event using the row's `old` snapshot (there is no `new` for a delete)", () => {
    const { channel, getCallback } = makeFakeChannel();
    vi.spyOn(supabase, "channel").mockReturnValue(channel as never);
    vi.spyOn(supabase, "removeChannel").mockReturnValue(undefined as never);

    const onChange = vi.fn();
    subscribeToPresence("room-1", onChange);

    const callback = getCallback();
    callback!({
      eventType: "DELETE",
      new: {},
      old: sampleParticipantRow,
      schema: "public",
      table: "study_room_participants",
      commit_timestamp: "2026-01-01T00:06:00.000Z",
      errors: [],
    });

    expect(onChange).toHaveBeenCalledWith({
      eventType: "DELETE",
      participant: {
        roomId: "room-1",
        userId: "user-b",
        joinedAt: "2026-01-01T00:05:00.000Z",
        leftAt: null,
      },
    });
  });
});
