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
    expect(screen.queryByText("Rooms in your groups")).not.toBeInTheDocument();
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
