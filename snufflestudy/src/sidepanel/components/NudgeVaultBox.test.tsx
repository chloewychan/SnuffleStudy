import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NudgeVaultBox } from "./NudgeVaultBox";
import { RefreshRegistryProvider, useRefreshAll } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as audioRecorder from "../../infrastructure/audio/audioRecorder";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import type { ExtensionMessage } from "../../shared/messages";
import type { ProducerTag } from "../../domain/rooms/producerTag";

// Same boundary-mocking convention as ProducerTagRecorder.test.tsx - this file is about
// NudgeVaultBox's own wiring (does it call PRODUCER_TAG_UPLOAD/NUDGE_VAULT_TEXT_CREATE/
// PRODUCER_TAG_DELETE/NUDGE_VAULT_TEXT_DELETE correctly and re-fetch/re-render afterward), not
// audioRecorder.ts's own mechanics (covered by its own test file).
vi.mock("../../infrastructure/audio/audioRecorder", () => ({
  MAX_RECORDING_MS: 10_000,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  getLastRecordingDurationMs: vi.fn(),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(audioRecorder.startRecording).mockReset();
  vi.mocked(audioRecorder.stopRecording).mockReset();
  vi.mocked(audioRecorder.getLastRecordingDurationMs).mockReset().mockReturnValue(4200);
});

afterEach(() => {
  vi.useRealTimers();
});

const sampleTag: ProducerTag = {
  id: "tag-1",
  userId: "user-self",
  audioUrl: "tag-1/clip.webm",
  durationMs: 4200,
  createdAt: "2026-01-01T00:00:00Z",
};

type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    PRODUCER_TAG_LIST_MINE: () => ({ ok: true, tags: [] }),
    NUDGE_VAULT_TEXT_LIST: () => ({ ok: true, texts: [] }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

function renderBox() {
  return render(
    <RefreshRegistryProvider>
      <NudgeVaultBox />
    </RefreshRegistryProvider>
  );
}

describe("NudgeVaultBox", () => {
  it("loads and renders both lists on mount", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        PRODUCER_TAG_LIST_MINE: () => ({ ok: true, tags: [sampleTag] }),
        NUDGE_VAULT_TEXT_LIST: () => ({
          ok: true,
          texts: [{ id: "text-1", body: "You've got this!", createdAt: 1000 }],
        }),
      })
    );

    renderBox();

    expect(await screen.findByText("4s clip")).toBeInTheDocument();
    expect(await screen.findByText("You've got this!")).toBeInTheDocument();
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: "PRODUCER_TAG_LIST_MINE" });
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: "NUDGE_VAULT_TEXT_LIST" });
  });

  describe("audio nudges", () => {
    it("recording and saving calls PRODUCER_TAG_UPLOAD, then re-fetches and shows the new clip", async () => {
      const blob = new Blob(["fake-audio"], { type: "audio/webm" });
      vi.mocked(audioRecorder.stopRecording).mockResolvedValue(blob);
      vi.spyOn(producerTagApi, "blobToBase64").mockResolvedValue("base64-audio");

      let listCallCount = 0;
      const uploadSpy = vi.fn(async () => ({ ok: true, tag: sampleTag }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          PRODUCER_TAG_UPLOAD: uploadSpy,
          PRODUCER_TAG_LIST_MINE: () => {
            listCallCount += 1;
            return { ok: true, tags: listCallCount === 1 ? [] : [sampleTag] };
          },
        })
      );

      renderBox();
      await waitFor(() => expect(screen.getByText(/no saved audio nudges yet/i)).toBeInTheDocument());

      fireEvent.click(screen.getByText("Record a tag (10s max)"));
      fireEvent.click(screen.getByText("Stop"));
      await waitFor(() => expect(screen.getByText("Save to vault")).toBeInTheDocument());

      fireEvent.click(screen.getByText("Save to vault"));

      await waitFor(() =>
        expect(uploadSpy).toHaveBeenCalledWith({
          type: "PRODUCER_TAG_UPLOAD",
          payload: { audioBase64: "base64-audio", mimeType: "audio/webm", durationMs: 4200 },
        })
      );
      expect(await screen.findByText("4s clip")).toBeInTheDocument();
    });

    it("Play lazily downloads and renders an audio player", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({ PRODUCER_TAG_LIST_MINE: () => ({ ok: true, tags: [sampleTag] }) })
      );
      const blob = new Blob(["fake-audio"], { type: "audio/webm" });
      const downloadSpy = vi.spyOn(producerTagApi, "downloadTagAudio").mockResolvedValue(blob);
      vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake") });

      renderBox();
      const row = (await screen.findByText("4s clip")).closest("li")!;

      fireEvent.click(within(row).getByRole("button", { name: "Play" }));

      await waitFor(() => expect(within(row).queryByRole("button", { name: "Play" })).not.toBeInTheDocument());
      expect(downloadSpy).toHaveBeenCalledWith("tag-1/clip.webm");
      expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });

    it("Delete calls PRODUCER_TAG_DELETE and removes the item from the list", async () => {
      const deleteSpy = vi.fn(async () => ({ ok: true }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          PRODUCER_TAG_LIST_MINE: () => ({ ok: true, tags: [sampleTag] }),
          PRODUCER_TAG_DELETE: deleteSpy,
        })
      );

      renderBox();
      const row = (await screen.findByText("4s clip")).closest("li")!;

      fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

      await waitFor(() =>
        expect(deleteSpy).toHaveBeenCalledWith({
          type: "PRODUCER_TAG_DELETE",
          payload: { tagId: "tag-1" },
        })
      );
      await waitFor(() => expect(screen.queryByText("4s clip")).not.toBeInTheDocument());
    });
  });

  describe("written nudges", () => {
    it("Add is disabled while the field is empty, and calls NUDGE_VAULT_TEXT_CREATE once filled", async () => {
      let listCallCount = 0;
      const createSpy = vi.fn(async () => ({
        ok: true,
        text: { id: "text-1", body: "Keep going!", createdAt: 2000 },
      }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          NUDGE_VAULT_TEXT_CREATE: createSpy,
          NUDGE_VAULT_TEXT_LIST: () => {
            listCallCount += 1;
            return {
              ok: true,
              texts: listCallCount === 1 ? [] : [{ id: "text-1", body: "Keep going!", createdAt: 2000 }],
            };
          },
        })
      );

      renderBox();
      await waitFor(() => expect(screen.getByText(/no saved written nudges yet/i)).toBeInTheDocument());

      const addButton = screen.getByRole("button", { name: "Add" });
      expect(addButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("New nudge"), { target: { value: "Keep going!" } });
      expect(addButton).not.toBeDisabled();
      fireEvent.click(addButton);

      await waitFor(() =>
        expect(createSpy).toHaveBeenCalledWith({
          type: "NUDGE_VAULT_TEXT_CREATE",
          payload: { body: "Keep going!" },
        })
      );
      expect(await screen.findByText("Keep going!")).toBeInTheDocument();
      // The input clears on success.
      expect(screen.getByLabelText("New nudge")).toHaveValue("");
    });

    it("submits on Enter, same as clicking Add", async () => {
      const createSpy = vi.fn(async () => ({
        ok: true,
        text: { id: "text-1", body: "Keep going!", createdAt: 2000 },
      }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({ NUDGE_VAULT_TEXT_CREATE: createSpy })
      );

      renderBox();
      await waitFor(() => expect(screen.getByLabelText("New nudge")).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText("New nudge"), { target: { value: "Keep going!" } });
      fireEvent.keyDown(screen.getByLabelText("New nudge"), { key: "Enter" });

      await waitFor(() => expect(createSpy).toHaveBeenCalled());
    });

    it("Delete calls NUDGE_VAULT_TEXT_DELETE and removes the item from the list", async () => {
      const deleteSpy = vi.fn(async () => ({ ok: true }));
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          NUDGE_VAULT_TEXT_LIST: () => ({
            ok: true,
            texts: [{ id: "text-1", body: "Keep going!", createdAt: 2000 }],
          }),
          NUDGE_VAULT_TEXT_DELETE: deleteSpy,
        })
      );

      renderBox();
      const row = (await screen.findByText("Keep going!")).closest("li")!;

      fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

      await waitFor(() =>
        expect(deleteSpy).toHaveBeenCalledWith({
          type: "NUDGE_VAULT_TEXT_DELETE",
          payload: { id: "text-1" },
        })
      );
      await waitFor(() => expect(screen.queryByText("Keep going!")).not.toBeInTheDocument());
    });
  });

  it("registers its own refresh with the refresh registry", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    function RefreshButton() {
      const refreshAll = useRefreshAll();
      return (
        <button type="button" onClick={refreshAll}>
          Refresh
        </button>
      );
    }

    render(
      <RefreshRegistryProvider>
        <NudgeVaultBox />
        <RefreshButton />
      </RefreshRegistryProvider>
    );

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledWith({ type: "PRODUCER_TAG_LIST_MINE" }));
    sendMessageSpy.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledWith({ type: "PRODUCER_TAG_LIST_MINE" }));
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: "NUDGE_VAULT_TEXT_LIST" });
  });
});
