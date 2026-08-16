import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyRoomPanel } from "./StudyRoomPanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import type { ExtensionMessage } from "../../shared/messages";

// v2 Task 13 fix round 1 (Important, code review): StudyRoomPanel.tsx now routes
// createRoom/listRooms/leaveRoom/listParticipants through sendMessage()/messageRouter.ts, the
// same convention every other panel test in this codebase uses (mirrors
// UnlockRequestPanel.test.tsx's/FriendGroupPanel.test.tsx's routeSendMessage helper exactly).
// Only studyRoomApi.joinRoom/subscribeToPresence remain genuinely direct calls (see
// StudyRoomPanel.tsx's own header comment for why), so only those two are still mocked via
// vi.mock("../../infrastructure/backend/studyRoomApi", ...) below - listRooms/createRoom/
// leaveRoom/listParticipants are exercised entirely through the sendMessage mock instead.
vi.mock("../../infrastructure/backend/studyRoomApi", () => ({
  joinRoom: vi.fn(),
  subscribeToPresence: vi.fn(),
}));

vi.mock("../../infrastructure/video/videoCallClient", () => ({
  joinCall: vi.fn(),
  leaveCall: vi.fn(),
  onVideoCallEvent: vi.fn(() => () => {}),
}));

const sampleRoom = { id: "room-1", name: "Thursday study group", ownerUserId: "user-a", createdAt: "2026-01-01T00:00:00.000Z" };

// Mirrors UnlockRequestPanel.test.tsx's/FriendGroupPanel.test.tsx's routeSendMessage helper
// exactly - lets each test override only the message types it cares about, everything else gets
// a healthy, empty-but-ok default.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    STUDY_ROOM_LIST: () => ({ ok: true, rooms: [] }),
    STUDY_ROOM_CREATE: () => ({ ok: true, room: sampleRoom }),
    STUDY_ROOM_LEAVE: () => ({ ok: true }),
    STUDY_ROOM_LIST_PARTICIPANTS: () => ({ ok: true, participants: [] }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(studyRoomApi.joinRoom).mockReset();
  vi.mocked(studyRoomApi.subscribeToPresence).mockReset().mockReturnValue(() => {});
  vi.mocked(videoCallClient.joinCall).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.leaveCall).mockReset();
  vi.mocked(videoCallClient.onVideoCallEvent).mockReset().mockReturnValue(() => {});
});

describe("StudyRoomPanel", () => {
  it("loads and renders the room list on mount via STUDY_ROOM_LIST", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) }));

    render(<StudyRoomPanel onClose={() => {}} />);

    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: "STUDY_ROOM_LIST" });
  });

  it("shows the load error inline when STUDY_ROOM_LIST fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: false, error: "network down" }) })
    );

    render(<StudyRoomPanel onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("creates a room via STUDY_ROOM_CREATE and adds it to the list without a full reload", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [] }),
        STUDY_ROOM_CREATE: () => ({ ok: true, room: sampleRoom }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("No study rooms yet — create one to get started.");

    fireEvent.change(screen.getByLabelText("New room name"), {
      target: { value: "Thursday study group" },
    });
    fireEvent.click(screen.getByText("Create room"));

    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "STUDY_ROOM_CREATE",
      payload: { name: "Thursday study group" },
    });
  });

  it("joins a room: calls studyRoomApi.joinRoom then videoCallClient.joinCall with the returned token, then fetches participants via STUDY_ROOM_LIST_PARTICIPANTS and subscribes to presence", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }),
        STUDY_ROOM_LIST_PARTICIPANTS: () => ({
          ok: true,
          participants: [{ roomId: "room-1", userId: "user-b", joinedAt: "2026-01-01T00:05:00.000Z", leftAt: null }],
        }),
      })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByText("Join"));

    // Joined-room view replaces the list view.
    expect(await screen.findByText("Leave room")).toBeInTheDocument();
    expect(studyRoomApi.joinRoom).toHaveBeenCalledWith("room-1");
    expect(videoCallClient.joinCall).toHaveBeenCalledWith("room-1", "livekit-jwt");
    expect(studyRoomApi.subscribeToPresence).toHaveBeenCalledWith("room-1", expect.any(Function));
    expect(screen.getByText("In this room (1)")).toBeInTheDocument();
  });

  it("surfaces a join error inline and does not get stuck showing the joined view", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockRejectedValue(new Error("not a participant"));

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByText("Join"));

    expect(await screen.findByRole("alert")).toHaveTextContent("not a participant");
    // Still on the list view (not the joined-room view) - no "Leave room" button rendered.
    expect(screen.queryByText("Leave room")).not.toBeInTheDocument();
    expect(videoCallClient.leaveCall).toHaveBeenCalled();
  });

  it("leaves a room: unsubscribes presence, ends the video call, and sends STUDY_ROOM_LEAVE", async () => {
    const unsubscribe = vi.fn();
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }),
        STUDY_ROOM_LIST_PARTICIPANTS: () => ({ ok: true, participants: [] }),
        STUDY_ROOM_LEAVE: () => ({ ok: true }),
      })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });
    vi.mocked(studyRoomApi.subscribeToPresence).mockReturnValue(unsubscribe);

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    fireEvent.click(screen.getByText("Leave room"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_LEAVE",
        payload: { roomId: "room-1" },
      })
    );
    expect(unsubscribe).toHaveBeenCalled();
    expect(videoCallClient.leaveCall).toHaveBeenCalled();
    // Back to the room-list view.
    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
  });
});
