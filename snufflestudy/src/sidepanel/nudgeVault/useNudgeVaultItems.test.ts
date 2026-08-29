import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useNudgeVaultItems } from "./useNudgeVaultItems";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { NudgeVaultText } from "../../infrastructure/backend/nudgeVaultApi";
import type { ProducerTag } from "../../domain/rooms/producerTag";

beforeEach(() => {
  vi.restoreAllMocks();
});

const sampleText: NudgeVaultText = {
  id: "text-1",
  body: "You've got this!",
  createdAt: new Date("2026-01-01T00:00:00Z").getTime(),
};

const sampleTag: ProducerTag = {
  id: "tag-1",
  userId: "user-self",
  audioUrl: "tag-1/clip.webm",
  durationMs: 4200,
  createdAt: "2026-01-02T00:00:00Z", // newer than sampleText
};

describe("useNudgeVaultItems", () => {
  it("merges written and audio items, sorted newest first", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (msg: any) => {
      if (msg.type === "NUDGE_VAULT_TEXT_LIST") return { ok: true, texts: [sampleText] };
      if (msg.type === "PRODUCER_TAG_LIST_MINE") return { ok: true, tags: [sampleTag] };
      return { ok: true };
    });

    const { result } = renderHook(() => useNudgeVaultItems());

    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toEqual([
      { kind: "audio", id: "tag-1", durationMs: 4200, createdAt: new Date(sampleTag.createdAt).getTime() },
      { kind: "written", id: "text-1", body: "You've got this!", createdAt: sampleText.createdAt },
    ]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces an error and keeps items empty when either fetch fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (msg: any) => {
      if (msg.type === "NUDGE_VAULT_TEXT_LIST") return { ok: false, error: "boom" };
      if (msg.type === "PRODUCER_TAG_LIST_MINE") return { ok: true, tags: [] };
      return { ok: true };
    });

    const { result } = renderHook(() => useNudgeVaultItems());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
    expect(result.current.items).toEqual([]);
  });

  it("surfaces an error (never throws) when sendMessage itself rejects", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("connection lost"));

    const { result } = renderHook(() => useNudgeVaultItems());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("connection lost");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("refresh() re-runs both fetches", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(async (msg: any) => {
      if (msg.type === "NUDGE_VAULT_TEXT_LIST") return { ok: true, texts: [] };
      if (msg.type === "PRODUCER_TAG_LIST_MINE") return { ok: true, tags: [] };
      return { ok: true };
    });

    const { result } = renderHook(() => useNudgeVaultItems());
    await waitFor(() => expect(result.current.loading).toBe(false));
    sendMessageSpy.mockClear();

    act(() => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({ type: "NUDGE_VAULT_TEXT_LIST" })
    );
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: "PRODUCER_TAG_LIST_MINE" });
  });
});
