// Covers messageRouter.ts's v2 Task 14 additions (PRODUCER_TAG_* cases), mirroring
// messageRouterStudyRooms.test.ts's own convention exactly: spies on producerTagApi's exported
// functions (this repo's established test style) so these cases are verified to route to the
// right underlying call with the right arguments, entirely offline - no real network call is
// ever made. PRODUCER_TAG_UPLOAD's Blob<->base64 round trip (see producerTagApi.ts's header
// comment on why it exists at all) is exercised for real here (not mocked away), since that
// conversion happens in messageRouter.ts's own case body, not inside producerTagApi.uploadTag
// itself.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import * as producerTagApi from "../infrastructure/backend/producerTagApi";
import type { IncomingProducerTag } from "../infrastructure/backend/producerTagApi";
import type { ProducerTag } from "../domain/rooms/producerTag";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

const sampleTag: ProducerTag = {
  id: "tag-1",
  userId: "user-a",
  audioUrl: "tag-1/clip.webm",
  durationMs: 4200,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("messageRouter — PRODUCER_TAG_*", () => {
  it("PRODUCER_TAG_UPLOAD decodes the base64 payload back into a Blob and calls producerTagApi.uploadTag with it and durationMs", async () => {
    const uploadSpy = vi.spyOn(producerTagApi, "uploadTag").mockResolvedValue(sampleTag);
    // "hello" base64-encoded, matching what producerTagApi.blobToBase64 would have produced
    // client-side for a Blob containing the bytes "hello".
    const audioBase64 = Buffer.from("hello", "utf8").toString("base64");

    const result = (await handleMessage({
      type: "PRODUCER_TAG_UPLOAD",
      payload: { audioBase64, mimeType: "audio/webm", durationMs: 4200 },
    })) as { ok: boolean; tag: ProducerTag };

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [blobArg, durationArg] = uploadSpy.mock.calls[0]!;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("audio/webm");
    expect(await blobArg.text()).toBe("hello");
    expect(durationArg).toBe(4200);
    expect(result).toEqual({ ok: true, tag: sampleTag });
  });

  it("PRODUCER_TAG_UPLOAD propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(producerTagApi, "uploadTag").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "PRODUCER_TAG_UPLOAD",
      payload: { audioBase64: "aGVsbG8=", mimeType: "audio/webm", durationMs: 1000 },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("PRODUCER_TAG_SEND_TO_FRIEND calls producerTagApi.sendToFriend with tagId and friendUserId", async () => {
    const spy = vi.spyOn(producerTagApi, "sendToFriend").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "PRODUCER_TAG_SEND_TO_FRIEND",
      payload: { tagId: "tag-1", friendUserId: "user-b" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("tag-1", "user-b");
    expect(result).toEqual({ ok: true });
  });

  it("PRODUCER_TAG_SEND_TO_FRIEND propagates a thrown error as ok:false", async () => {
    vi.spyOn(producerTagApi, "sendToFriend").mockRejectedValue(
      new Error("new row violates row-level security policy")
    );

    const result = (await handleMessage({
      type: "PRODUCER_TAG_SEND_TO_FRIEND",
      payload: { tagId: "tag-1", friendUserId: "user-c" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "new row violates row-level security policy" });
  });

  it("PRODUCER_TAG_SEND_TO_ROOM calls producerTagApi.sendToRoom with tagId and roomId", async () => {
    const spy = vi.spyOn(producerTagApi, "sendToRoom").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "PRODUCER_TAG_SEND_TO_ROOM",
      payload: { tagId: "tag-1", roomId: "room-1" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("tag-1", "room-1");
    expect(result).toEqual({ ok: true });
  });

  it("PRODUCER_TAG_SEND_TO_ROOM propagates a thrown error as ok:false", async () => {
    vi.spyOn(producerTagApi, "sendToRoom").mockRejectedValue(
      new Error("new row violates row-level security policy")
    );

    const result = (await handleMessage({
      type: "PRODUCER_TAG_SEND_TO_ROOM",
      payload: { tagId: "tag-1", roomId: "room-x" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "new row violates row-level security policy" });
  });

  it("PRODUCER_TAG_SENDS_FETCH calls producerTagApi.fetchIncomingProducerTagSends with sinceTimestamp", async () => {
    const sends: IncomingProducerTag[] = [
      { tagId: "tag-1", senderUserId: "user-b", sentAt: 1_700_000_000_000, audioUrl: "tag-1/clip.webm", durationMs: 3000 },
    ];
    const spy = vi.spyOn(producerTagApi, "fetchIncomingProducerTagSends").mockResolvedValue(sends);

    const result = (await handleMessage({
      type: "PRODUCER_TAG_SENDS_FETCH",
      payload: { sinceTimestamp: 1_600_000_000_000 },
    })) as { ok: boolean; sends: IncomingProducerTag[] };

    expect(spy).toHaveBeenCalledWith(1_600_000_000_000);
    expect(result).toEqual({ ok: true, sends });
  });

  it("PRODUCER_TAG_FETCH_BY_ID calls producerTagApi.fetchProducerTagById with tagId", async () => {
    const spy = vi.spyOn(producerTagApi, "fetchProducerTagById").mockResolvedValue(sampleTag);

    const result = (await handleMessage({
      type: "PRODUCER_TAG_FETCH_BY_ID",
      payload: { tagId: "tag-1" },
    })) as { ok: boolean; tag: ProducerTag | null };

    expect(spy).toHaveBeenCalledWith("tag-1");
    expect(result).toEqual({ ok: true, tag: sampleTag });
  });

  it("PRODUCER_TAG_FETCH_BY_ID returns ok:true with tag:null (not a throw) when the tag doesn't resolve to anything", async () => {
    vi.spyOn(producerTagApi, "fetchProducerTagById").mockResolvedValue(null);

    const result = (await handleMessage({
      type: "PRODUCER_TAG_FETCH_BY_ID",
      payload: { tagId: "tag-missing" },
    })) as { ok: boolean; tag: ProducerTag | null };

    expect(result).toEqual({ ok: true, tag: null });
  });
});
