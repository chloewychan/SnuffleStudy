import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyRoomPanel } from "./StudyRoomPanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import * as audioRecorder from "../../infrastructure/audio/audioRecorder";
import type { ExtensionMessage } from "../../shared/messages";

// v2 Task 14: producerTagApi.subscribeToRoomProducerTags/downloadTagAudio are called DIRECTLY by
// StudyRoomPanel.tsx (same two-exceptions precedent as studyRoomApi.joinRoom/subscribeToPresence
// above - see producerTagApi.ts's own header comment), so they're mocked alongside those two.
// blobToBase64 is also called directly (a pure browser-API helper, not a backend call).
// uploadTag/sendToFriend/sendToRoom/fetchIncomingProducerTagSends/fetchProducerTagById are NOT
// mocked here - they're exercised entirely through the sendMessage mock, same treatment
// listRooms/createRoom/leaveRoom/listParticipants already get.
vi.mock("../../infrastructure/backend/studyRoomApi", () => ({
  joinRoom: vi.fn(),
  subscribeToPresence: vi.fn(),
}));

vi.mock("../../infrastructure/backend/producerTagApi", () => ({
  subscribeToRoomProducerTags: vi.fn(),
  downloadTagAudio: vi.fn(),
  blobToBase64: vi.fn(),
}));

vi.mock("../../infrastructure/audio/audioRecorder", () => ({
  MAX_RECORDING_MS: 10_000,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  getLastRecordingDurationMs: vi.fn(),
}));

// v2 Task 13 fix round 1 (Important, code review): StudyRoomPanel.tsx now routes
// createRoom/listRooms/leaveRoom/listParticipants through sendMessage()/messageRouter.ts, the
// same convention every other panel test in this codebase uses (mirrors
// UnlockRequestPanel.test.tsx's/FriendGroupPanel.test.tsx's routeSendMessage helper exactly).
// Only studyRoomApi.joinRoom/subscribeToPresence remain genuinely direct calls (see
// StudyRoomPanel.tsx's own header comment for why) - the mock for those two lives above, next to
// producerTagApi's/audioRecorder's own direct-call mocks.
vi.mock("../../infrastructure/video/videoCallClient", () => ({
  joinCall: vi.fn(),
  leaveCall: vi.fn(),
  onVideoCallEvent: vi.fn(() => () => {}),
  // v3.3 Task 9: mid-call camera/mic toggles.
  setCameraEnabled: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
}));

const sampleRoom = { id: "room-1", name: "Thursday study group", ownerUserId: "user-a", createdAt: "2026-01-01T00:00:00.000Z" };

// Mirrors UnlockRequestPanel.test.tsx's/FriendGroupPanel.test.tsx's routeSendMessage helper
// exactly - lets each test override only the message types it cares about, everything else gets
// a healthy, empty-but-ok default.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    // v3.2 Task 2: StudyRoomPanel now checks AUTH_GET_SESSION on mount (it had no auth check
    // before this task) - defaults to signed-in so every pre-existing test below (all written
    // against implicit signed-in behavior) keeps exercising exactly what it did before. The new
    // "signed out" describe block below overrides this per-test.
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    STUDY_ROOM_LIST: () => ({ ok: true, rooms: [] }),
    STUDY_ROOM_CREATE: () => ({ ok: true, room: sampleRoom }),
    STUDY_ROOM_LEAVE: () => ({ ok: true }),
    STUDY_ROOM_LIST_PARTICIPANTS: () => ({ ok: true, participants: [] }),
    STUDY_ROOM_ARCHIVE: () => ({ ok: true }),
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
  vi.mocked(videoCallClient.setCameraEnabled).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.setMicrophoneEnabled).mockReset().mockResolvedValue(undefined);
  vi.mocked(producerTagApi.subscribeToRoomProducerTags).mockReset().mockReturnValue(() => {});
  vi.mocked(producerTagApi.downloadTagAudio).mockReset();
  vi.mocked(producerTagApi.blobToBase64).mockReset().mockResolvedValue("ZmFrZQ==");
  vi.mocked(audioRecorder.startRecording).mockReset();
  vi.mocked(audioRecorder.stopRecording).mockReset();
  vi.mocked(audioRecorder.getLastRecordingDurationMs).mockReset().mockReturnValue(4200);
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
    // v3.3 Task 9: the two pre-join toggles default to on, so an unmodified join still passes
    // { camera: true, microphone: true } - preserving today's "always publish both" behavior.
    expect(videoCallClient.joinCall).toHaveBeenCalledWith("room-1", "livekit-jwt", {
      camera: true,
      microphone: true,
    });
    expect(studyRoomApi.subscribeToPresence).toHaveBeenCalledWith("room-1", expect.any(Function));
    expect(screen.getByText("In this room (1)")).toBeInTheDocument();
  });

  // QA-discovered bug (v3.2 Task 9): videoCallClient.joinCall publishes the local camera/mic
  // and emits "track-added" synchronously, DURING the call - well before handleJoinRoom's later
  // setJoinedRoom(room), which is what actually mounts the joined-room view's <div ref={gridRef}>
  // grid container. Every previous test here mocks joinCall as a bare mockResolvedValue that
  // never emits anything during the call, so none of them exercised this ordering at all. This
  // test mimics the real videoCallClient's behavior (emit before resolving) to catch it.
  it("still attaches a track that was emitted before the joined-room view finished mounting", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
    vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    const videoElement = document.createElement("video");
    vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
      capturedListener?.({
        type: "track-added",
        participantIdentity: "user-self",
        isLocal: true,
        element: videoElement,
      });
    });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    await waitFor(() => expect(videoElement.isConnected).toBe(true));
  });

  // v3.3 Task 3: the local camera preview is mirrored (display-only, via a CSS transform) so it
  // behaves like a real mirror - raising your right hand appears on your own screen's left. Must
  // never touch a remote participant's element, since remote viewers still need the true
  // (unmirrored) orientation.
  it("mirrors the local video element but not a remote participant's element", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
    vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    const localVideo = document.createElement("video");
    const remoteVideo = document.createElement("video");
    vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
      capturedListener?.({
        type: "track-added",
        participantIdentity: "user-self",
        isLocal: true,
        element: localVideo,
      });
      capturedListener?.({
        type: "track-added",
        participantIdentity: "user-b",
        isLocal: false,
        element: remoteVideo,
      });
    });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    expect(localVideo.style.transform).toBe("scaleX(-1)");
    expect(remoteVideo.style.transform).toBe("");
  });

  // QA-discovered bug (v3.2 Task 9): a local-media-error used to have nowhere to go - the join
  // still "succeeded" (joinedRoom set, presence loaded) with silently no video/audio and no way
  // for the user to learn why. Confirms the actionable case renders a working fix action.
  it("shows an actionable guidance message and opens a tab to grant access on a local-media-error", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });
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

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/can't be requested from this panel/i);

    fireEvent.click(screen.getByRole("button", { name: /open a tab to grant access/i }));
    expect(tabsCreateSpy).toHaveBeenCalledWith({ url: expect.stringContaining("options.html") });
  });

  // A genuinely missing/broken device isn't fixable by opening a tab - confirms the guidance
  // button only appears for the actionable (Chrome side-panel permission) case.
  it("does not show the grant-access button for a non-actionable local-media-error", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    let capturedListener: ((event: videoCallClient.VideoCallEvent) => void) | null = null;
    vi.mocked(videoCallClient.onVideoCallEvent).mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    vi.mocked(videoCallClient.joinCall).mockImplementation(async () => {
      capturedListener?.({
        type: "local-media-error",
        kind: "camera",
        message: "Requested device not found",
        actionable: false,
      });
    });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    expect(await screen.findByRole("alert")).toHaveTextContent("Requested device not found");
    expect(screen.queryByRole("button", { name: /open a tab to grant access/i })).not.toBeInTheDocument();
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

// v3.3 Task 6: archive study rooms (soft delete). "Archive this room" is an owner-only action -
// AUTH_GET_SESSION's default mock resolves to "user-self" (see routeSendMessage above), and
// sampleRoom is owned by "user-a", so most tests here use a second, self-owned room to exercise
// the visible/enabled path.
describe("StudyRoomPanel — Archive (v3.3 Task 6)", () => {
  const ownRoom = {
    id: "room-2",
    name: "My own room",
    ownerUserId: "user-self",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("does not show an Archive button for a room this user does not own", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    expect(screen.queryByText("Archive this room")).not.toBeInTheDocument();
  });

  it("shows an Archive button for a room this user owns", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom, ownRoom] }) })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");

    expect(screen.getByText("Archive this room")).toBeInTheDocument();
  });

  it("archives an owned room via STUDY_ROOM_ARCHIVE and removes it from the list without a full reload", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom, ownRoom] }),
        STUDY_ROOM_ARCHIVE: () => ({ ok: true }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");

    fireEvent.click(screen.getByText("Archive this room"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_ARCHIVE",
        payload: { roomId: "room-2" },
      })
    );
    await waitFor(() => expect(screen.queryByText("My own room")).not.toBeInTheDocument());
    // The other, non-owned room is unaffected.
    expect(screen.getByText("Thursday study group")).toBeInTheDocument();
  });

  it("shows the error inline and keeps the room in the list when STUDY_ROOM_ARCHIVE fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        STUDY_ROOM_ARCHIVE: () => ({ ok: false, error: "not the room owner" }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");

    fireEvent.click(screen.getByText("Archive this room"));

    expect(await screen.findByRole("alert")).toHaveTextContent("not the room owner");
    expect(screen.getByText("My own room")).toBeInTheDocument();
  });
});

// v3.3 Task 13: invite-only study rooms - the owner-only "Manage access" section. Same
// AUTH_GET_SESSION default ("user-self") as the Archive block above, so `ownRoom` (owned by
// "user-self") exercises the visible/enabled path.
describe("StudyRoomPanel — Manage access (v3.3 Task 13)", () => {
  const ownRoom = {
    id: "room-2",
    name: "My own room",
    ownerUserId: "user-self",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const memberships = [{ groupId: "group-1", userId: "user-self", joinedAt: "2026-01-01T00:00:00.000Z" }];
  const members = [
    { groupId: "group-1", userId: "user-self", joinedAt: "2026-01-01T00:00:00.000Z" },
    { groupId: "group-1", userId: "friend-1", joinedAt: "2026-01-01T00:00:00.000Z" },
  ];

  it("does not show a Manage access button for a room this user does not own", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    expect(screen.queryByText("Manage access")).not.toBeInTheDocument();
  });

  it("shows a Manage access button for a room this user owns, expanding to list friends via GROUP_LIST_MINE/GROUP_LIST_MEMBERS with an Invite toggle", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        GROUP_LIST_MINE: () => ({ ok: true, memberships }),
        GROUP_LIST_MEMBERS: () => ({ ok: true, members }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");

    fireEvent.click(screen.getByText("Manage access"));

    expect(await screen.findByText("friend-1")).toBeInTheDocument();
    expect(screen.getByText("Invite")).toBeInTheDocument();
    // The caller's own membership row is excluded from the friend list.
    expect(screen.queryByText("user-self")).not.toBeInTheDocument();
  });

  it("shows Remove access for a friend already invited (STUDY_ROOM_INVITEES_LIST)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        GROUP_LIST_MINE: () => ({ ok: true, memberships }),
        GROUP_LIST_MEMBERS: () => ({ ok: true, members }),
        STUDY_ROOM_INVITEES_LIST: () => ({
          ok: true,
          invitees: [{ roomId: "room-2", userId: "friend-1", invitedBy: "user-self", invitedAt: "2026-01-01T00:00:00.000Z" }],
        }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");
    fireEvent.click(screen.getByText("Manage access"));

    expect(await screen.findByText("Remove access")).toBeInTheDocument();
  });

  it("invites a friend via STUDY_ROOM_INVITEE_ADD and flips the toggle to Remove access", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        GROUP_LIST_MINE: () => ({ ok: true, memberships }),
        GROUP_LIST_MEMBERS: () => ({ ok: true, members }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
        STUDY_ROOM_INVITEE_ADD: () => ({ ok: true }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");
    fireEvent.click(screen.getByText("Manage access"));
    await screen.findByText("Invite");

    fireEvent.click(screen.getByText("Invite"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_INVITEE_ADD",
        payload: { roomId: "room-2", userId: "friend-1" },
      })
    );
    expect(await screen.findByText("Remove access")).toBeInTheDocument();
  });

  it("removes an invite via STUDY_ROOM_INVITEE_REMOVE and flips the toggle back to Invite", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        GROUP_LIST_MINE: () => ({ ok: true, memberships }),
        GROUP_LIST_MEMBERS: () => ({ ok: true, members }),
        STUDY_ROOM_INVITEES_LIST: () => ({
          ok: true,
          invitees: [{ roomId: "room-2", userId: "friend-1", invitedBy: "user-self", invitedAt: "2026-01-01T00:00:00.000Z" }],
        }),
        STUDY_ROOM_INVITEE_REMOVE: () => ({ ok: true }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");
    fireEvent.click(screen.getByText("Manage access"));
    await screen.findByText("Remove access");

    fireEvent.click(screen.getByText("Remove access"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_INVITEE_REMOVE",
        payload: { roomId: "room-2", userId: "friend-1" },
      })
    );
    expect(await screen.findByText("Invite")).toBeInTheDocument();
  });

  it("shows the error inline and leaves the toggle unchanged when STUDY_ROOM_INVITEE_ADD fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        GROUP_LIST_MINE: () => ({ ok: true, memberships }),
        GROUP_LIST_MEMBERS: () => ({ ok: true, members }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
        STUDY_ROOM_INVITEE_ADD: () => ({ ok: false, error: "not the room owner" }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");
    fireEvent.click(screen.getByText("Manage access"));
    await screen.findByText("Invite");

    fireEvent.click(screen.getByText("Invite"));

    expect(await screen.findByRole("alert")).toHaveTextContent("not the room owner");
    expect(screen.getByText("Invite")).toBeInTheDocument();
  });

  it("hides the section again when Manage access is toggled a second time", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        GROUP_LIST_MINE: () => ({ ok: true, memberships }),
        GROUP_LIST_MEMBERS: () => ({ ok: true, members }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("My own room");

    fireEvent.click(screen.getByText("Manage access"));
    await screen.findByText("Invite");

    fireEvent.click(screen.getByText("Hide manage access"));
    expect(screen.queryByText("Invite")).not.toBeInTheDocument();
  });
});

// v3.3 Task 9: camera/mic on/off toggle, both before joining and in-room. Mock-verified only - the
// real "no track actually published"/"real permission wall" behavior needs real camera hardware or
// a real LiveKit connection (deferred to Task 15's two-account QA pass, per that task's own DoD
// item "camera/mic toggles work both pre-join and mid-call"). What's verified here: the right
// videoCallClient export is called with the right boolean, and the pre-join toggles' values are
// exactly what flows into joinCall's `initial` param.
describe("StudyRoomPanel — Camera/Mic toggle (v3.3 Task 9)", () => {
  it("defaults both pre-join toggles to on, preserving today's behavior when neither is touched", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    expect(screen.getByLabelText("Join with camera on")).toBeChecked();
    expect(screen.getByLabelText("Join with mic on")).toBeChecked();
  });

  it("unchecking the pre-join camera toggle passes { camera: false, microphone: true } to joinCall", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByLabelText("Join with camera on"));
    fireEvent.click(screen.getByText("Join"));

    await screen.findByText("Leave room");
    expect(videoCallClient.joinCall).toHaveBeenCalledWith("room-1", "livekit-jwt", {
      camera: false,
      microphone: true,
    });
  });

  it("unchecking the pre-join mic toggle passes { camera: true, microphone: false } to joinCall", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByLabelText("Join with mic on"));
    fireEvent.click(screen.getByText("Join"));

    await screen.findByText("Leave room");
    expect(videoCallClient.joinCall).toHaveBeenCalledWith("room-1", "livekit-jwt", {
      camera: true,
      microphone: false,
    });
  });

  it("mid-room: clicking the Camera toggle calls videoCallClient.setCameraEnabled(false) and flips its own label", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    expect(screen.getByText("Camera: On")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Camera: On"));

    expect(videoCallClient.setCameraEnabled).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Camera: Off")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Camera: Off"));
    expect(videoCallClient.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Camera: On")).toBeInTheDocument();
  });

  it("mid-room: clicking the Mic toggle calls videoCallClient.setMicrophoneEnabled(false) and flips its own label", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    expect(screen.getByText("Mic: On")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Mic: On"));

    expect(videoCallClient.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Mic: Off")).toBeInTheDocument();
  });

  // The existing "open a tab to grant access" affordance is unchanged - it's driven entirely off
  // videoCallClient's own local-media-error event (see videoCallClient.test.ts's mid-call-toggle
  // coverage for the emission side), so mid-room toggle failures reuse the exact same rendering
  // path a join-time failure already exercises (covered above in the main describe block). This
  // test only confirms the toggle click itself doesn't throw/crash when the underlying call
  // rejects (defensive .catch in the handler).
  it("does not crash the panel when a mid-room toggle's underlying call rejects", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });
    vi.mocked(videoCallClient.setCameraEnabled).mockRejectedValue(new Error("boom"));

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    fireEvent.click(screen.getByText("Camera: On"));

    // The optimistic label still flips even though the underlying call rejected - local state,
    // not the SDK call's outcome, drives the button's label per this task's brief.
    expect(await screen.findByText("Camera: Off")).toBeInTheDocument();
  });
});

describe("StudyRoomPanel — Producer Tags (v2 Task 14)", () => {
  async function joinSampleRoom(overrides: Partial<Record<ExtensionMessage["type"], Handler>> = {}) {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }),
        STUDY_ROOM_LIST_PARTICIPANTS: () => ({ ok: true, participants: [] }),
        ...overrides,
      })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Thursday study group");
    fireEvent.click(screen.getByText("Join"));
    await screen.findByText("Leave room");

    return sendMessageSpy;
  }

  it("subscribes to the room's producer-tag broadcasts on join, and shows the recorder plus an empty state", async () => {
    await joinSampleRoom();

    expect(producerTagApi.subscribeToRoomProducerTags).toHaveBeenCalledWith("room-1", expect.any(Function));
    expect(screen.getByText("Record a tag (10s max)")).toBeInTheDocument();
    expect(screen.getByText("No producer tags sent to this room yet.")).toBeInTheDocument();
  });

  it("unsubscribes from producer-tag broadcasts on leave", async () => {
    const unsubscribeTags = vi.fn();
    vi.mocked(producerTagApi.subscribeToRoomProducerTags).mockReturnValue(unsubscribeTags);
    await joinSampleRoom({ STUDY_ROOM_LEAVE: () => ({ ok: true }) });

    fireEvent.click(screen.getByText("Leave room"));

    await waitFor(() => expect(unsubscribeTags).toHaveBeenCalled());
  });

  it("records, uploads (base64-encoded), and sends a tag to the room via PRODUCER_TAG_UPLOAD then PRODUCER_TAG_SEND_TO_ROOM", async () => {
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(
      new Blob(["fake-audio"], { type: "audio/webm" })
    );
    const sendMessageSpy = await joinSampleRoom({
      PRODUCER_TAG_UPLOAD: () => ({
        ok: true,
        tag: { id: "tag-1", userId: "user-a", audioUrl: "tag-1/clip.webm", durationMs: 4200, createdAt: "x" },
      }),
      PRODUCER_TAG_SEND_TO_ROOM: () => ({ ok: true }),
    });

    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(screen.getByText("Send to room")).not.toBeDisabled());

    fireEvent.click(screen.getByText("Send to room"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "PRODUCER_TAG_SEND_TO_ROOM",
        payload: { tagId: "tag-1", roomId: "room-1" },
      })
    );
    expect(producerTagApi.blobToBase64).toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "PRODUCER_TAG_UPLOAD",
      payload: { audioBase64: "ZmFrZQ==", mimeType: "audio/webm", durationMs: 4200 },
    });
  });

  it("surfaces an error inline when sending to the room fails", async () => {
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(new Blob(["x"], { type: "audio/webm" }));
    await joinSampleRoom({
      PRODUCER_TAG_UPLOAD: () => ({ ok: false, error: "Failed to upload the recorded audio." }),
    });

    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(screen.getByText("Send to room")).not.toBeDisabled());

    fireEvent.click(screen.getByText("Send to room"));

    expect(await screen.findByText(/Tag not sent/)).toHaveTextContent(
      "Failed to upload the recorded audio."
    );
  });

  it("renders a live producer-tag broadcast, resolves it via PRODUCER_TAG_FETCH_BY_ID, and plays it on demand", async () => {
    const sendMessageSpy = await joinSampleRoom({
      PRODUCER_TAG_FETCH_BY_ID: () => ({
        ok: true,
        tag: { id: "tag-1", userId: "user-c", audioUrl: "tag-1/clip.webm", durationMs: 4000, createdAt: "x" },
      }),
    });
    vi.mocked(producerTagApi.downloadTagAudio).mockResolvedValue(new Blob(["audio-bytes"]));

    // Simulate a live broadcast arriving over the (mocked) Realtime subscription - invokes the
    // onTag callback StudyRoomPanel.tsx passed to subscribeToRoomProducerTags when it joined.
    const onTag = vi.mocked(producerTagApi.subscribeToRoomProducerTags).mock.calls[0]![1];
    onTag({ tagId: "tag-1", roomId: "room-1", senderUserId: "user-c", sentAt: "2026-01-01T00:00:00.000Z" });

    // Shows up immediately (sender known), even before PRODUCER_TAG_FETCH_BY_ID resolves.
    expect(await screen.findByText(/From user-c/)).toBeInTheDocument();

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "PRODUCER_TAG_FETCH_BY_ID",
        payload: { tagId: "tag-1" },
      })
    );
    await waitFor(() => expect(screen.getByText(/From user-c — 4s/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Play"));

    await waitFor(() => expect(producerTagApi.downloadTagAudio).toHaveBeenCalledWith("tag-1/clip.webm"));
    expect(document.querySelector("audio")).toBeInTheDocument();
  });
});

// v3.2 Task 2: this panel had no auth check at all before this task - signed out, every action
// (create/list/join a room) requires an authenticated user, so this used to surface as a generic
// "Not signed in." load error rather than an actionable prompt.
describe("StudyRoomPanel — signed-out gate (v3.2 Task 2)", () => {
  it("shows an inline sign-in prompt instead of the room list when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    render(<StudyRoomPanel onClose={() => {}} />);

    expect(
      await screen.findByText("Sign in to create or join a study room with your friends.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText("Rooms among your friends")).not.toBeInTheDocument();
    expect(screen.queryByText("New room name")).not.toBeInTheDocument();
  });

  it("does not show the sign-in prompt while sign-in status is still loading", async () => {
    let resolveSelf: (value: unknown) => void = () => {};
    const selfPromise = new Promise((resolve) => {
      resolveSelf = resolve;
    });
    vi.spyOn(messenger, "sendMessage").mockImplementation((msg: ExtensionMessage) => {
      if (msg.type === "AUTH_GET_SESSION") return selfPromise as Promise<unknown>;
      return routeSendMessage({})(msg);
    });

    render(<StudyRoomPanel onClose={() => {}} />);

    // Still resolving self-identity: must show the normal (signed-in-shaped) empty state, not a
    // premature sign-in prompt.
    await screen.findByText("No study rooms yet — create one to get started.");
    expect(
      screen.queryByText("Sign in to create or join a study room with your friends.")
    ).not.toBeInTheDocument();

    resolveSelf({ ok: true, session: { user: { id: "user-self" } } });
    // Resolves to signed-in: the room list stays the room list, no gate ever appears.
    await waitFor(() =>
      expect(
        screen.queryByText("Sign in to create or join a study room with your friends.")
      ).not.toBeInTheDocument()
    );
  });

  it("shows the room list once the inline SignInForm reports a signed-in session", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        AUTH_GET_SESSION: () => ({ ok: true, session: null }),
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }),
        AUTH_VERIFY_OTP: () => ({ ok: true, session: { user: { id: "user-self" } } }),
      })
    );

    render(<StudyRoomPanel onClose={() => {}} />);
    await screen.findByText("Sign in to create or join a study room with your friends.");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByText("Send sign-in code"));
    await screen.findByLabelText("Code");
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Verify code"));

    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "AUTH_VERIFY_OTP",
      payload: { email: "a@b.com", token: "123456" },
    });
  });
});
