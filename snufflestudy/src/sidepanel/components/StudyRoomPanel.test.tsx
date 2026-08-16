import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyRoomPanel } from "./StudyRoomPanel";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";

// v2 Task 13: StudyRoomPanel.tsx calls studyRoomApi.ts/videoCallClient.ts DIRECTLY (not via
// sendMessage - see this panel's own header comment for why), so this test mocks both modules
// wholesale, mirroring SnufflesOverlay.test.tsx's identical vi.mock(...)-a-whole-module pattern
// for coachingApi.ts. The presence-subscription/live-video wiring these two modules do internally
// is already covered by their own *.test.ts files (studyRoomApi.test.ts,
// infrastructure/video/videoCallClient.test.ts) - this file only exercises what StudyRoomPanel.tsx
// itself is responsible for: rendering room state and calling the right functions in the right
// order in response to user actions.
vi.mock("../../infrastructure/backend/studyRoomApi", () => ({
  listRooms: vi.fn(),
  createRoom: vi.fn(),
  joinRoom: vi.fn(),
  leaveRoom: vi.fn(),
  listParticipants: vi.fn(),
  subscribeToPresence: vi.fn(),
}));

vi.mock("../../infrastructure/video/videoCallClient", () => ({
  joinCall: vi.fn(),
  leaveCall: vi.fn(),
  onVideoCallEvent: vi.fn(() => () => {}),
}));

const sampleRoom = { id: "room-1", name: "Thursday study group", ownerUserId: "user-a", createdAt: "2026-01-01T00:00:00.000Z" };

beforeEach(() => {
  vi.mocked(studyRoomApi.listRooms).mockReset().mockResolvedValue([]);
  vi.mocked(studyRoomApi.createRoom).mockReset();
  vi.mocked(studyRoomApi.joinRoom).mockReset();
  vi.mocked(studyRoomApi.leaveRoom).mockReset().mockResolvedValue(undefined);
  vi.mocked(studyRoomApi.listParticipants).mockReset().mockResolvedValue([]);
  vi.mocked(studyRoomApi.subscribeToPresence).mockReset().mockReturnValue(() => {});
  vi.mocked(videoCallClient.joinCall).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.leaveCall).mockReset();
  vi.mocked(videoCallClient.onVideoCallEvent).mockReset().mockReturnValue(() => {});
});

describe("StudyRoomPanel", () => {
  it("loads and renders the room list on mount", async () => {
    vi.mocked(studyRoomApi.listRooms).mockResolvedValue([sampleRoom]);

    render(<StudyRoomPanel onClose={() => {}} />);

    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
    expect(studyRoomApi.listRooms).toHaveBeenCalled();
  });

  it("shows the load error inline when listRooms fails", async () => {
    vi.mocked(studyRoomApi.listRooms).mockRejectedValue(new Error("network down"));

    render(<StudyRoomPanel onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("creates a room and adds it to the list without a full reload", async () => {
    vi.mocked(studyRoomApi.listRooms).mockResolvedValue([]);
    vi.mocked(studyRoomApi.createRoom).mockResolvedValue(sampleRoom);

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("No study rooms yet — create one to get started.");

    fireEvent.change(screen.getByLabelText("New room name"), {
      target: { value: "Thursday study group" },
    });
    fireEvent.click(screen.getByText("Create room"));

    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
    expect(studyRoomApi.createRoom).toHaveBeenCalledWith("Thursday study group");
  });

  it("joins a room: calls studyRoomApi.joinRoom then videoCallClient.joinCall with the returned token, then subscribes to presence", async () => {
    vi.mocked(studyRoomApi.listRooms).mockResolvedValue([sampleRoom]);
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });
    vi.mocked(studyRoomApi.listParticipants).mockResolvedValue([
      { roomId: "room-1", userId: "user-b", joinedAt: "2026-01-01T00:05:00.000Z", leftAt: null },
    ]);

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
    vi.mocked(studyRoomApi.listRooms).mockResolvedValue([sampleRoom]);
    vi.mocked(studyRoomApi.joinRoom).mockRejectedValue(new Error("not a participant"));

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByText("Join"));

    expect(await screen.findByRole("alert")).toHaveTextContent("not a participant");
    // Still on the list view (not the joined-room view) - no "Leave room" button rendered.
    expect(screen.queryByText("Leave room")).not.toBeInTheDocument();
    expect(videoCallClient.leaveCall).toHaveBeenCalled();
  });

  it("leaves a room: unsubscribes presence, ends the video call, and records leaving server-side", async () => {
    const unsubscribe = vi.fn();
    vi.mocked(studyRoomApi.listRooms).mockResolvedValue([sampleRoom]);
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });
    vi.mocked(studyRoomApi.subscribeToPresence).mockReturnValue(unsubscribe);

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    fireEvent.click(screen.getByText("Leave room"));

    await waitFor(() => expect(studyRoomApi.leaveRoom).toHaveBeenCalledWith("room-1"));
    expect(unsubscribe).toHaveBeenCalled();
    expect(videoCallClient.leaveCall).toHaveBeenCalled();
    // Back to the room-list view.
    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
  });
});
