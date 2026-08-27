import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import {
  uploadTag,
  sendToFriend,
  sendToRoom,
  fetchIncomingProducerTagSends,
  pollIncomingProducerTagSends,
  fetchProducerTagById,
  downloadTagAudio,
  subscribeToRoomProducerTags,
  blobToBase64,
  blobFromBase64,
} from "./producerTagApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// studyRoomApi.test.ts/nudgeApi.test.ts.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors studyRoomApi.test.ts's
// makeBuilder, extended with `gt`/`maybeSingle` since this file's queries use them.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    insert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    gt: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    insert: vi.fn(),
    delete: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    gt: vi.fn(),
    order: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.insert.mockReturnValue(builder);
  builder.delete.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.gt.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.single.mockReturnValue(builder);
  builder.maybeSingle.mockReturnValue(builder);
  return builder;
}

function mockGetUser(userId: string | null) {
  return vi.spyOn(supabase.auth, "getUser").mockResolvedValue(
    (userId
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: { message: "Not signed in." } }) as never
  );
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

const sampleTagRow = {
  id: "tag-1",
  user_id: "user-a",
  audio_url: "tag-1/clip.webm",
  duration_ms: 4200,
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("producerTagApi.uploadTag", () => {
  it("inserts a producer_tags row with a client-generated id, then uploads the blob to that path", async () => {
    mockGetUser("user-a");
    vi.spyOn(crypto, "randomUUID").mockReturnValue("tag-1" as `${string}-${string}-${string}-${string}-${string}`);
    const insertBuilder = makeBuilder({ data: sampleTagRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(insertBuilder as never);
    const uploadMock = vi.fn().mockResolvedValue({ data: { path: "tag-1/clip.webm" }, error: null });
    vi.spyOn(supabase.storage, "from").mockReturnValue({ upload: uploadMock } as never);

    const blob = new Blob(["fake-audio"], { type: "audio/webm" });
    const result = await uploadTag(blob, 4200);

    expect(fromSpy).toHaveBeenCalledWith("producer_tags");
    expect(insertBuilder.insert).toHaveBeenCalledWith({
      id: "tag-1",
      user_id: "user-a",
      audio_url: "tag-1/clip.webm",
      duration_ms: 4200,
    });
    expect(uploadMock).toHaveBeenCalledWith("tag-1/clip.webm", blob, {
      contentType: "audio/webm",
      upsert: false,
    });
    expect(result).toEqual({
      id: "tag-1",
      userId: "user-a",
      audioUrl: "tag-1/clip.webm",
      durationMs: 4200,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("rounds and floors durationMs at zero rather than trusting a negative/fractional caller value", async () => {
    mockGetUser("user-a");
    vi.spyOn(crypto, "randomUUID").mockReturnValue("tag-1" as `${string}-${string}-${string}-${string}-${string}`);
    const insertBuilder = makeBuilder({ data: sampleTagRow, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(insertBuilder as never);
    vi.spyOn(supabase.storage, "from").mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
    } as never);

    await uploadTag(new Blob(["x"]), -5.7);

    expect(insertBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({ duration_ms: 0 }));
  });

  it("throws when not signed in, without touching the database or storage", async () => {
    mockGetUser(null);
    const fromSpy = vi.spyOn(supabase, "from");
    const storageFromSpy = vi.spyOn(supabase.storage, "from");

    await expect(uploadTag(new Blob(["x"]), 1000)).rejects.toThrow("Not signed in.");
    expect(fromSpy).not.toHaveBeenCalled();
    expect(storageFromSpy).not.toHaveBeenCalled();
  });

  it("throws with the Postgres error message when the producer_tags insert is denied, without attempting the upload", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "new row violates row-level security policy" } }) as never
    );
    const uploadMock = vi.fn();
    vi.spyOn(supabase.storage, "from").mockReturnValue({ upload: uploadMock } as never);

    await expect(uploadTag(new Blob(["x"]), 1000)).rejects.toThrow(
      "new row violates row-level security policy"
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("rolls back the producer_tags row (best-effort delete) when the storage upload fails", async () => {
    mockGetUser("user-a");
    vi.spyOn(crypto, "randomUUID").mockReturnValue("tag-1" as `${string}-${string}-${string}-${string}-${string}`);
    const insertBuilder = makeBuilder({ data: sampleTagRow, error: null });
    const deleteBuilder = makeBuilder({ data: null, error: null });
    const fromSpy = vi
      .spyOn(supabase, "from")
      .mockReturnValueOnce(insertBuilder as never)
      .mockReturnValueOnce(deleteBuilder as never);
    vi.spyOn(supabase.storage, "from").mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: null, error: { message: "storage denied" } }),
    } as never);

    await expect(uploadTag(new Blob(["x"]), 1000)).rejects.toThrow("storage denied");

    expect(fromSpy).toHaveBeenCalledTimes(2);
    expect(deleteBuilder.delete).toHaveBeenCalled();
    expect(deleteBuilder.eq).toHaveBeenCalledWith("id", "tag-1");
  });
});

describe("producerTagApi.sendToFriend", () => {
  it("inserts a producer_tag_sends row targeting the friend, recipient_room_id null", async () => {
    mockGetUser("user-a");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await sendToFriend("tag-1", "user-b");

    expect(fromSpy).toHaveBeenCalledWith("producer_tag_sends");
    expect(builder.insert).toHaveBeenCalledWith({
      tag_id: "tag-1",
      sender_user_id: "user-a",
      recipient_user_id: "user-b",
      recipient_room_id: null,
    });
  });

  // QA-discovered bug (v3.4 QA pass): the raw Postgres RLS message used to pass straight through
  // to the user - harmless before Task 8's cooldown gate, but a real experience gap once "sent
  // too many audio nudges too fast" became a common way to hit this exact denial. Mirrors
  // nudgeApi.test.ts's identical assertion for sendNudge()'s own friendly-message translation.
  it("throws a friendly cooldown/toggle message, not the raw Postgres RLS error, when the send is denied", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "new row violates row-level security policy" } }) as never
    );

    await expect(sendToFriend("tag-1", "user-b")).rejects.toThrow(
      "Couldn't send that audio nudge — this friend may have nudges turned off, or you're on cooldown."
    );
  });
});

// Fake of supabase-js's RealtimeChannel - just enough surface for sendToRoom's
// .channel(topic, {config}).httpSend(event, payload) and subscribeToRoomProducerTags's
// .channel(topic, {config}).on("broadcast", filter, cb).subscribe() chains.
function makeFakeChannel(httpSendResult: { success: true } | { success: false; status: number; error: string }) {
  let capturedCallback: ((payload: unknown) => void) | null = null;
  const channel = {
    on: vi.fn((_type: string, _filter: unknown, callback: (payload: unknown) => void) => {
      capturedCallback = callback;
      return channel;
    }),
    subscribe: vi.fn(() => channel),
    httpSend: vi.fn().mockResolvedValue(httpSendResult),
  };
  return { channel, getCallback: () => capturedCallback };
}

describe("producerTagApi.sendToRoom", () => {
  it("inserts a producer_tag_sends row targeting the room, then broadcasts over a private Realtime channel scoped to that room", async () => {
    mockGetUser("user-a");
    const insertBuilder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(insertBuilder as never);
    const { channel } = makeFakeChannel({ success: true });
    const channelSpy = vi.spyOn(supabase, "channel").mockReturnValue(channel as never);
    const removeChannelSpy = vi.spyOn(supabase, "removeChannel").mockReturnValue(undefined as never);

    await sendToRoom("tag-1", "room-1");

    expect(fromSpy).toHaveBeenCalledWith("producer_tag_sends");
    expect(insertBuilder.insert).toHaveBeenCalledWith({
      tag_id: "tag-1",
      sender_user_id: "user-a",
      recipient_user_id: null,
      recipient_room_id: "room-1",
    });
    expect(channelSpy).toHaveBeenCalledWith("study-room-producer-tags:room-1", {
      config: { private: true },
    });
    expect(channel.httpSend).toHaveBeenCalledWith(
      "producer-tag",
      expect.objectContaining({ tagId: "tag-1", roomId: "room-1", senderUserId: "user-a" })
    );
    expect(removeChannelSpy).toHaveBeenCalledWith(channel);
  });

  it("throws with the Postgres error message when the send is denied, without ever attempting a broadcast", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "new row violates row-level security policy" } }) as never
    );
    const channelSpy = vi.spyOn(supabase, "channel");

    await expect(sendToRoom("tag-1", "room-1")).rejects.toThrow(
      "new row violates row-level security policy"
    );
    expect(channelSpy).not.toHaveBeenCalled();
  });

  it("does NOT throw when the insert succeeds but the broadcast fails (best-effort, per this codebase's graceful-degradation convention)", async () => {
    mockGetUser("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(makeBuilder({ data: null, error: null }) as never);
    const { channel } = makeFakeChannel({ success: false, status: 500, error: "broadcast failed" });
    vi.spyOn(supabase, "channel").mockReturnValue(channel as never);
    vi.spyOn(supabase, "removeChannel").mockReturnValue(undefined as never);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendToRoom("tag-1", "room-1")).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("producerTagApi.subscribeToRoomProducerTags", () => {
  it("subscribes to a private channel scoped to the room's topic, and maps broadcast events through onTag", () => {
    const { channel, getCallback } = makeFakeChannel({ success: true });
    const channelSpy = vi.spyOn(supabase, "channel").mockReturnValue(channel as never);
    const removeChannelSpy = vi.spyOn(supabase, "removeChannel").mockReturnValue(undefined as never);

    const onTag = vi.fn();
    const unsubscribe = subscribeToRoomProducerTags("room-1", onTag);

    expect(channelSpy).toHaveBeenCalledWith("study-room-producer-tags:room-1", {
      config: { private: true },
    });
    expect(channel.on).toHaveBeenCalledWith("broadcast", { event: "producer-tag" }, expect.any(Function));
    expect(channel.subscribe).toHaveBeenCalled();

    const callback = getCallback();
    expect(callback).not.toBeNull();
    const payload = { tagId: "tag-1", roomId: "room-1", senderUserId: "user-a", sentAt: "2026-01-01T00:00:00.000Z" };
    callback!({ type: "broadcast", event: "producer-tag", payload });

    expect(onTag).toHaveBeenCalledWith(payload);

    unsubscribe();
    expect(removeChannelSpy).toHaveBeenCalledWith(channel);
  });
});

describe("producerTagApi.downloadTagAudio", () => {
  it("downloads the object at the given path from the producer-tags bucket", async () => {
    const fakeBlob = new Blob(["audio-bytes"]);
    const downloadMock = vi.fn().mockResolvedValue({ data: fakeBlob, error: null });
    const storageFromSpy = vi.spyOn(supabase.storage, "from").mockReturnValue({
      download: downloadMock,
    } as never);

    const result = await downloadTagAudio("tag-1/clip.webm");

    expect(storageFromSpy).toHaveBeenCalledWith("producer-tags");
    expect(downloadMock).toHaveBeenCalledWith("tag-1/clip.webm");
    expect(result).toBe(fakeBlob);
  });

  it("throws with the Storage error message on a denied/failed download", async () => {
    vi.spyOn(supabase.storage, "from").mockReturnValue({
      download: vi.fn().mockResolvedValue({ data: null, error: { message: "not authorized" } }),
    } as never);

    await expect(downloadTagAudio("tag-1/clip.webm")).rejects.toThrow("not authorized");
  });
});

describe("producerTagApi.fetchProducerTagById", () => {
  it("returns the mapped tag when found", async () => {
    const builder = makeBuilder({ data: sampleTagRow, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await fetchProducerTagById("tag-1");

    expect(fromSpy).toHaveBeenCalledWith("producer_tags");
    expect(builder.eq).toHaveBeenCalledWith("id", "tag-1");
    expect(result).toEqual({
      id: "tag-1",
      userId: "user-a",
      audioUrl: "tag-1/clip.webm",
      durationMs: 4200,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns null (not a throw) when RLS/the row genuinely doesn't resolve to anything", async () => {
    vi.spyOn(supabase, "from").mockReturnValue(makeBuilder({ data: null, error: null }) as never);

    await expect(fetchProducerTagById("tag-missing")).resolves.toBeNull();
  });

  it("throws on a genuine query error", async () => {
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "network error" } }) as never
    );

    await expect(fetchProducerTagById("tag-1")).rejects.toThrow("network error");
  });
});

describe("producerTagApi.fetchIncomingProducerTagSends / pollIncomingProducerTagSends", () => {
  const joinedRow = {
    tag_id: "tag-1",
    sender_user_id: "user-b",
    sent_at: "2026-01-01T00:05:00.000Z",
    producer_tags: { audio_url: "tag-1/clip.webm", duration_ms: 3000 },
  };

  it("fetchIncomingProducerTagSends returns friend-recipient sends joined with their producer_tags row, mapped", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [joinedRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await fetchIncomingProducerTagSends(0);

    expect(fromSpy).toHaveBeenCalledWith("producer_tag_sends");
    expect(builder.eq).toHaveBeenCalledWith("recipient_user_id", "user-a");
    expect(result).toEqual([
      {
        tagId: "tag-1",
        senderUserId: "user-b",
        sentAt: new Date("2026-01-01T00:05:00.000Z").getTime(),
        audioUrl: "tag-1/clip.webm",
        durationMs: 3000,
      },
    ]);
  });

  it("skips a row whose joined producer_tags is null (the tag was deleted after being sent), rather than surfacing a broken entry", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: [{ ...joinedRow, producer_tags: null }], error: null }) as never
    );

    const result = await fetchIncomingProducerTagSends(0);
    expect(result).toEqual([]);
  });

  it("fetchIncomingProducerTagSends degrades to [] (never throws) when signed out", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(fetchIncomingProducerTagSends(0)).resolves.toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("pollIncomingProducerTagSends distinguishes a confirmed-empty poll from a failed one", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(makeBuilder({ data: [], error: null }) as never);

    await expect(pollIncomingProducerTagSends(0)).resolves.toEqual({ ok: true, sends: [] });
  });

  it("pollIncomingProducerTagSends reports ok:false (not an empty success) on a query failure - the cursor-safety contract alarmHandlers.ts relies on", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "network down" } }) as never
    );

    await expect(pollIncomingProducerTagSends(0)).resolves.toEqual({ ok: false });
  });

  it("pollIncomingProducerTagSends reports ok:false when the auth check itself fails (not just when signed out cleanly)", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValue(new Error("boom"));

    await expect(pollIncomingProducerTagSends(0)).resolves.toEqual({ ok: false });
  });
});

describe("producerTagApi.blobToBase64 / blobFromBase64", () => {
  it("round-trips a Blob's bytes through base64", async () => {
    const original = new Blob(["hello producer tag"], { type: "audio/webm" });

    const base64 = await blobToBase64(original);
    const roundTripped = blobFromBase64(base64, "audio/webm");

    expect(roundTripped.type).toBe("audio/webm");
    const text = await roundTripped.text();
    expect(text).toBe("hello producer tag");
  });
});
