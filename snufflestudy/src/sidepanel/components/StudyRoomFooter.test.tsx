import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyRoomFooter } from "./StudyRoomFooter";
import { StudyRoomSessionProvider, useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";
import { RefreshRegistryProvider } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import type { ExtensionMessage } from "../../shared/messages";
import type { StudyRoom } from "../../domain/rooms/studyRoom";

// v4.1 Task 7: StudyRoomPanel.tsx is deleted and split into StudyRoomsBox.tsx (its own test file)
// and this file (its joined-room branch, now the persistent StudyRoomFooter.tsx). This file
// drives the join through the shared study-room session directly (a tiny harness below), rather
// than through StudyRoomsBox's own UI, since the footer's own behavior shouldn't depend on how a
// room was joined.
vi.mock("../../infrastructure/backend/studyRoomApi", () => ({
  joinRoom: vi.fn(),
  subscribeToPresence: vi.fn(),
}));

vi.mock("../../infrastructure/video/videoCallClient", () => ({
  joinCall: vi.fn(),
  leaveCall: vi.fn(),
  onVideoCallEvent: vi.fn(() => () => {}),
  setCameraEnabled: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
}));

const sampleRoom: StudyRoom = {
  id: "room-1",
  name: "Thursday study group",
  ownerUserId: "user-a",
  createdAt: "2026-01-01T00:00:00.000Z",
};

type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    STUDY_ROOM_LIST_PARTICIPANTS: () => ({ ok: true, participants: [] }),
    STUDY_ROOM_LEAVE: () => ({ ok: true }),
    NUDGE_VAULT_TEXT_LIST: () => ({ ok: true, texts: [] }),
    PRODUCER_TAG_LIST_MINE: () => ({ ok: true, tags: [] }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

// Drives the shared session's joinRoom() directly, bypassing StudyRoomsBox's own room-list UI.
function Harness() {
  const { joinRoom } = useStudyRoomSession();
  return (
    <>
      <button type="button" onClick={() => void joinRoom(sampleRoom, { camera: true, microphone: true })}>
        Join (test harness)
      </button>
      <StudyRoomFooter />
    </>
  );
}

function renderFooter() {
  return render(
    <RefreshRegistryProvider>
      <StudyRoomSessionProvider>
        <Harness />
      </StudyRoomSessionProvider>
    </RefreshRegistryProvider>
  );
}

async function joinSampleRoom() {
  fireEvent.click(screen.getByText("Join (test harness)"));
  await screen.findByText("Leave room");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(studyRoomApi.joinRoom).mockReset().mockResolvedValue({ token: "livekit-jwt" });
  vi.mocked(studyRoomApi.subscribeToPresence).mockReset().mockReturnValue(() => {});
  vi.mocked(videoCallClient.joinCall).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.leaveCall).mockReset();
  vi.mocked(videoCallClient.onVideoCallEvent).mockReset().mockReturnValue(() => {});
  vi.mocked(videoCallClient.setCameraEnabled).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.setMicrophoneEnabled).mockReset().mockResolvedValue(undefined);
});

describe("StudyRoomFooter", () => {
  it("renders nothing when no room is joined", () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));
    renderFooter();
    expect(screen.queryByText("Leave room")).not.toBeInTheDocument();
  });

  it("shows the joined room's name and no participant-name list once joined", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST_PARTICIPANTS: () => ({
          ok: true,
          participants: [{ roomId: "room-1", userId: "user-b", joinedAt: "2026-01-01T00:05:00.000Z", leftAt: null }],
        }),
      })
    );

    renderFooter();
    await joinSampleRoom();

    expect(screen.getByRole("heading", { name: "Thursday study group" })).toBeInTheDocument();
    // v4.1 Task 7: the plain participant-name list is removed entirely - every participant
    // already has a tile.
    expect(screen.queryByText("In this room (1)")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: /in this room/i })).not.toBeInTheDocument();
  });

  it("has no way to record a producer tag from inside the footer", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    renderFooter();
    await joinSampleRoom();

    expect(screen.queryByText(/record a tag/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Producer tags")).not.toBeInTheDocument();
  });

  it("toggles a tile's selected state on click, reflected in aria-pressed", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
    vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
      capturedListener?.({
        type: "track-added",
        participantIdentity: "user-b",
        isLocal: false,
        element: document.createElement("video"),
      });
    });

    renderFooter();
    await joinSampleRoom();

    const tile = screen.getByText("user-b").closest('[data-participant="user-b"]') as HTMLElement;
    expect(tile).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(tile);
    expect(tile).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(tile);
    expect(tile).toHaveAttribute("aria-pressed", "false");
  });

  it("mirrors the local video element but not a remote participant's element", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
    vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    const localVideo = document.createElement("video");
    const remoteVideo = document.createElement("video");
    vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
      capturedListener?.({ type: "track-added", participantIdentity: "user-self", isLocal: true, element: localVideo });
      capturedListener?.({ type: "track-added", participantIdentity: "user-b", isLocal: false, element: remoteVideo });
    });

    renderFooter();
    await joinSampleRoom();

    expect(localVideo.style.transform).toBe("scaleX(-1)");
    expect(remoteVideo.style.transform).toBe("");
  });

  it("shows an actionable guidance message and opens a tab to grant access on a local-media-error", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));
    const tabsCreateSpy = vi.spyOn(chrome.tabs, "create").mockReturnValue(undefined as never);

    let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
    vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
      capturedListener?.({
        type: "local-media-error",
        kind: "camera",
        message: "Camera/microphone access can't be requested from this panel.",
        actionable: true,
      });
    });

    renderFooter();
    await joinSampleRoom();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/can't be requested from this panel/i);

    fireEvent.click(screen.getByRole("button", { name: /open a tab to grant access/i }));
    expect(tabsCreateSpy).toHaveBeenCalledWith({ url: expect.stringContaining("options.html") });
  });

  it("mid-room: clicking the Camera toggle calls videoCallClient.setCameraEnabled(false) and flips its own label", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    renderFooter();
    await joinSampleRoom();

    expect(screen.getByText("Camera: On")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Camera: On"));

    expect(videoCallClient.setCameraEnabled).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Camera: Off")).toBeInTheDocument();
  });

  it("leaves a room: unsubscribes presence, ends the video call, and sends STUDY_ROOM_LEAVE", async () => {
    const unsubscribe = vi.fn();
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));
    vi.mocked(studyRoomApi.subscribeToPresence).mockReturnValue(unsubscribe);

    renderFooter();
    await joinSampleRoom();

    fireEvent.click(screen.getByText("Leave room"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_LEAVE",
        payload: { roomId: "room-1" },
      })
    );
    expect(unsubscribe).toHaveBeenCalled();
    expect(videoCallClient.leaveCall).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Leave room")).not.toBeInTheDocument());
  });

  describe("Nudge Vault picker and sending (v4.1 Task 7, Decision 8)", () => {
    it("loads and merges written + audio vault items, sorted by createdAt descending", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          NUDGE_VAULT_TEXT_LIST: () => ({
            ok: true,
            texts: [{ id: "text-1", body: "Keep going!", createdAt: 1000 }],
          }),
          PRODUCER_TAG_LIST_MINE: () => ({
            ok: true,
            tags: [
              {
                id: "tag-1",
                userId: "user-self",
                audioUrl: "tag-1/clip.webm",
                durationMs: 4200,
                createdAt: "1970-01-01T00:00:02.000Z", // 2000ms - newer than the written text above
              },
            ],
          }),
        })
      );

      renderFooter();
      await joinSampleRoom();

      const select = await screen.findByLabelText("Nudge Vault item");
      const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
      // Audio (2000ms) is newer than the written text (1000ms) - sorted first, after the
      // placeholder option.
      expect(options).toEqual(["Choose a saved nudge", "Audio clip (4s)", "Keep going!"]);
    });

    it("sends a written nudge (NUDGE_SEND with vaultTextId) to every selected participant, then clears the selection", async () => {
      let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
      vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
        capturedListener = listener;
        return () => {};
      });
      vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
        capturedListener?.({ type: "track-added", participantIdentity: "user-b", isLocal: false, element: document.createElement("video") });
        capturedListener?.({ type: "track-added", participantIdentity: "user-c", isLocal: false, element: document.createElement("video") });
      });

      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          NUDGE_VAULT_TEXT_LIST: () => ({ ok: true, texts: [{ id: "text-1", body: "Keep going!", createdAt: 1000 }] }),
          NUDGE_SEND: () => ({ ok: true }),
        })
      );

      renderFooter();
      await joinSampleRoom();

      fireEvent.click(screen.getByText("user-b").closest('[data-participant="user-b"]')!);
      fireEvent.click(screen.getByText("user-c").closest('[data-participant="user-c"]')!);

      const select = await screen.findByLabelText("Nudge Vault item");
      fireEvent.change(select, { target: { value: "written:text-1" } });

      fireEvent.click(screen.getByRole("button", { name: /^nudge \(2 selected\)$/i }));

      await waitFor(() =>
        expect(sendMessageSpy).toHaveBeenCalledWith({
          type: "NUDGE_SEND",
          payload: { friendUserId: "user-b", vaultTextId: "text-1" },
        })
      );
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "NUDGE_SEND",
        payload: { friendUserId: "user-c", vaultTextId: "text-1" },
      });

      // Selection is cleared afterward - both tiles report aria-pressed="false" again.
      await waitFor(() => {
        expect(screen.getByText("user-b").closest('[data-participant="user-b"]')).toHaveAttribute(
          "aria-pressed",
          "false"
        );
      });
    });

    it("sends an audio nudge (PRODUCER_TAG_SEND_TO_FRIEND with tagId) when an audio vault item is selected", async () => {
      let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
      vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
        capturedListener = listener;
        return () => {};
      });
      vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
        capturedListener?.({ type: "track-added", participantIdentity: "user-b", isLocal: false, element: document.createElement("video") });
      });

      const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          PRODUCER_TAG_LIST_MINE: () => ({
            ok: true,
            tags: [{ id: "tag-1", userId: "user-self", audioUrl: "tag-1/clip.webm", durationMs: 4200, createdAt: "2026-01-01T00:00:00.000Z" }],
          }),
          PRODUCER_TAG_SEND_TO_FRIEND: () => ({ ok: true }),
        })
      );

      renderFooter();
      await joinSampleRoom();

      fireEvent.click(screen.getByText("user-b").closest('[data-participant="user-b"]')!);

      const select = await screen.findByLabelText("Nudge Vault item");
      fireEvent.change(select, { target: { value: "audio:tag-1" } });

      fireEvent.click(screen.getByRole("button", { name: /^nudge \(1 selected\)$/i }));

      await waitFor(() =>
        expect(sendMessageSpy).toHaveBeenCalledWith({
          type: "PRODUCER_TAG_SEND_TO_FRIEND",
          payload: { tagId: "tag-1", friendUserId: "user-b" },
        })
      );
    });

    it("disables the Nudge button until both a vault item and at least one participant are selected", async () => {
      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          NUDGE_VAULT_TEXT_LIST: () => ({ ok: true, texts: [{ id: "text-1", body: "Keep going!", createdAt: 1000 }] }),
        })
      );

      renderFooter();
      await joinSampleRoom();

      expect(screen.getByRole("button", { name: /^nudge \(0 selected\)$/i })).toBeDisabled();

      const select = await screen.findByLabelText("Nudge Vault item");
      fireEvent.change(select, { target: { value: "written:text-1" } });

      // Still disabled - a vault item is picked, but nothing is selected yet.
      expect(screen.getByRole("button", { name: /^nudge \(0 selected\)$/i })).toBeDisabled();
    });

    it("surfaces a partial-failure error without losing track of which sends actually failed", async () => {
      let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
      vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
        capturedListener = listener;
        return () => {};
      });
      vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
        capturedListener?.({ type: "track-added", participantIdentity: "user-b", isLocal: false, element: document.createElement("video") });
      });

      vi.spyOn(messenger, "sendMessage").mockImplementation(
        routeSendMessage({
          NUDGE_VAULT_TEXT_LIST: () => ({ ok: true, texts: [{ id: "text-1", body: "Keep going!", createdAt: 1000 }] }),
          NUDGE_SEND: () => ({ ok: false, error: "Nudge cooldown active." }),
        })
      );

      renderFooter();
      await joinSampleRoom();

      fireEvent.click(screen.getByText("user-b").closest('[data-participant="user-b"]')!);
      const select = await screen.findByLabelText("Nudge Vault item");
      fireEvent.change(select, { target: { value: "written:text-1" } });
      fireEvent.click(screen.getByRole("button", { name: /^nudge \(1 selected\)$/i }));

      expect(await screen.findByText(/nudge cooldown active/i)).toBeInTheDocument();
    });
  });
});

// QA-discovered bug precedent (v3.3 QA pass), preserved from StudyRoomPanel.test.tsx: video tiles
// must not carry over stale media elements from a previous join session.
describe("StudyRoomFooter — stale tile cleanup across leave/rejoin (v3.3 QA pass precedent)", () => {
  it("does not carry over a stale tile from a previous join when leaving and rejoining", async () => {
    let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
    vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });

    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    const firstSessionVideo = document.createElement("video");
    vi.mocked(videoCallClient.joinCall).mockImplementationOnce(async () => {
      capturedListener?.({ type: "track-added", participantIdentity: "user-self", isLocal: true, element: firstSessionVideo });
    });

    renderFooter();
    await joinSampleRoom();
    expect(firstSessionVideo.isConnected).toBe(true);
    expect(screen.getByText("You")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Leave room"));
    await waitFor(() => expect(screen.queryByText("Leave room")).not.toBeInTheDocument());

    vi.mocked(videoCallClient.joinCall).mockImplementationOnce(async () => {});
    await joinSampleRoom();

    expect(firstSessionVideo.isConnected).toBe(false);
    expect(screen.getAllByText("You")).toHaveLength(1);
  });
});
