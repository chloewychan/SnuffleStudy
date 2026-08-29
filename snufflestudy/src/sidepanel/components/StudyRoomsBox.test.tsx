import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyRoomsBox } from "./StudyRoomsBox";
import { StudyRoomSessionProvider } from "../studyRoom/StudyRoomSessionContext";
import { RefreshRegistryProvider, useRefreshAll } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import type { ExtensionMessage } from "../../shared/messages";

// v4.1 Task 7: StudyRoomPanel.tsx is deleted and split into this file (the Study tab's
// list/create/manage-access box) and StudyRoomFooter.tsx (the persistent joined-room view,
// covered by its own test file). This file's coverage is StudyRoomPanel.test.tsx's old "not
// joined" branch coverage, adapted for: click-to-select + one "Join study room" button (replacing
// each room's own per-item Join button), and "Archive this room" now rendered inside
// ManageAccessSection instead of beside it. Join/leave mechanics themselves (the shared session)
// are exercised here only through this box's own "select a room, click Join" flow - the deeper
// join/leave/tile/media-event behavior is StudyRoomFooter.test.tsx's concern, since that's what
// actually renders once joined.
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

const sampleRoom = {
  id: "room-1",
  name: "Thursday study group",
  ownerUserId: "user-a",
  createdAt: "2026-01-01T00:00:00.000Z",
};

type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    STUDY_ROOM_LIST: () => ({ ok: true, rooms: [] }),
    STUDY_ROOM_CREATE: () => ({ ok: true, room: sampleRoom }),
    STUDY_ROOM_LIST_PARTICIPANTS: () => ({ ok: true, participants: [] }),
    STUDY_ROOM_ARCHIVE: () => ({ ok: true }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

function renderBox() {
  return render(
    <RefreshRegistryProvider>
      <StudyRoomSessionProvider>
        <StudyRoomsBox />
      </StudyRoomSessionProvider>
    </RefreshRegistryProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(studyRoomApi.joinRoom).mockReset();
  vi.mocked(studyRoomApi.subscribeToPresence).mockReset().mockReturnValue(() => {});
  vi.mocked(videoCallClient.joinCall).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.leaveCall).mockReset();
  vi.mocked(videoCallClient.onVideoCallEvent).mockReset().mockReturnValue(() => {});
});

describe("StudyRoomsBox", () => {
  it("loads and renders the room list on mount via STUDY_ROOM_LIST", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) }));

    renderBox();

    expect(await screen.findByText("Thursday study group")).toBeInTheDocument();
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: "STUDY_ROOM_LIST" });
  });

  it("shows the load error inline when STUDY_ROOM_LIST fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: false, error: "network down" }) })
    );

    renderBox();

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("creates a room via STUDY_ROOM_CREATE and adds it to the list without a full reload", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [] }),
        STUDY_ROOM_CREATE: () => ({ ok: true, room: sampleRoom }),
      })
    );

    renderBox();
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

  // v4.1 Task 7: the core behavior change - no per-item Join button; selecting a room then
  // pressing the one "Join study room" button joins it.
  it("has no per-item Join button, and joins the selected room via the single 'Join study room' button", async () => {
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

    renderBox();
    await screen.findByText("Thursday study group");

    expect(screen.queryByRole("button", { name: /^join$/i })).not.toBeInTheDocument();
    const joinButton = screen.getByRole("button", { name: "Join study room" });
    expect(joinButton).toBeDisabled();

    fireEvent.click(screen.getByText("Thursday study group"));
    expect(joinButton).not.toBeDisabled();

    fireEvent.click(joinButton);

    await waitFor(() => expect(studyRoomApi.joinRoom).toHaveBeenCalledWith("room-1"));
    expect(videoCallClient.joinCall).toHaveBeenCalledWith("room-1", "livekit-jwt", {
      camera: true,
      microphone: true,
    });
  });

  it("keeps the Join button disabled while nothing is selected", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );

    renderBox();
    await screen.findByText("Thursday study group");

    expect(screen.getByRole("button", { name: "Join study room" })).toBeDisabled();
  });

  it("surfaces a join error inline via the shared session's joinError", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockRejectedValue(new Error("not a participant"));

    renderBox();
    await screen.findByText("Thursday study group");

    fireEvent.click(screen.getByText("Thursday study group"));
    fireEvent.click(screen.getByRole("button", { name: "Join study room" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("not a participant");
    expect(videoCallClient.leaveCall).toHaveBeenCalled();
  });

  it("registers loadRooms with the refresh registry and re-fetches on refreshAll()", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );

    function RefreshButton() {
      const refreshAll = useRefreshAll();
      return (
        <button type="button" onClick={refreshAll}>
          Refresh all
        </button>
      );
    }

    render(
      <RefreshRegistryProvider>
        <StudyRoomSessionProvider>
          <StudyRoomsBox />
          <RefreshButton />
        </StudyRoomSessionProvider>
      </RefreshRegistryProvider>
    );

    await screen.findByText("Thursday study group");
    const callsBeforeRefresh = sendMessageSpy.mock.calls.filter((c) => (c[0] as ExtensionMessage).type === "STUDY_ROOM_LIST").length;

    fireEvent.click(screen.getByText("Refresh all"));

    await waitFor(() => {
      const callsAfterRefresh = sendMessageSpy.mock.calls.filter((c) => (c[0] as ExtensionMessage).type === "STUDY_ROOM_LIST").length;
      expect(callsAfterRefresh).toBeGreaterThan(callsBeforeRefresh);
    });
  });
});

// v3.3 Task 6: archive study rooms (soft delete). "Archive this room" is an owner-only action -
// v4.1 Task 7: now rendered inside ManageAccessSection, only once "Manage access" is opened.
describe("StudyRoomsBox — Archive (v3.3 Task 6, relocated in v4.1 Task 7)", () => {
  const ownRoom = {
    id: "room-2",
    name: "My own room",
    ownerUserId: "user-self",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("does not show an Archive button until Manage access is opened for an owned room", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        FRIENDS_LIST: () => ({ ok: true, friendIds: [] }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
      })
    );

    renderBox();
    await screen.findByText("My own room");

    expect(screen.queryByText("Archive this room")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Manage access"));

    expect(await screen.findByText("Archive this room")).toBeInTheDocument();
  });

  it("does not show a Manage access or Archive button for a room this user does not own", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );

    renderBox();
    await screen.findByText("Thursday study group");

    expect(screen.queryByText("Manage access")).not.toBeInTheDocument();
    expect(screen.queryByText("Archive this room")).not.toBeInTheDocument();
  });

  it("archives an owned room via STUDY_ROOM_ARCHIVE and removes it from the list without a full reload", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom, ownRoom] }),
        FRIENDS_LIST: () => ({ ok: true, friendIds: [] }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
        STUDY_ROOM_ARCHIVE: () => ({ ok: true }),
      })
    );

    renderBox();
    await screen.findByText("My own room");
    fireEvent.click(screen.getByText("Manage access"));
    await screen.findByText("Archive this room");

    fireEvent.click(screen.getByText("Archive this room"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_ARCHIVE",
        payload: { roomId: "room-2" },
      })
    );
    await waitFor(() => expect(screen.queryByText("My own room")).not.toBeInTheDocument());
    expect(screen.getByText("Thursday study group")).toBeInTheDocument();
  });

  it("shows the error inline and keeps the room in the list when STUDY_ROOM_ARCHIVE fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        FRIENDS_LIST: () => ({ ok: true, friendIds: [] }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
        STUDY_ROOM_ARCHIVE: () => ({ ok: false, error: "not the room owner" }),
      })
    );

    renderBox();
    await screen.findByText("My own room");
    fireEvent.click(screen.getByText("Manage access"));
    await screen.findByText("Archive this room");

    fireEvent.click(screen.getByText("Archive this room"));

    expect(await screen.findByRole("alert")).toHaveTextContent("not the room owner");
    expect(screen.getByText("My own room")).toBeInTheDocument();
  });
});

describe("StudyRoomsBox — Manage access (v3.3 Task 13)", () => {
  const ownRoom = {
    id: "room-2",
    name: "My own room",
    ownerUserId: "user-self",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const friendIds = ["friend-1"];

  it("shows a Manage access button for a room this user owns, expanding to list friends via FRIENDS_LIST with an Invite toggle", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        FRIENDS_LIST: () => ({ ok: true, friendIds }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
      })
    );

    renderBox();
    await screen.findByText("My own room");

    fireEvent.click(screen.getByText("Manage access"));

    expect(await screen.findByText("friend-1")).toBeInTheDocument();
    expect(screen.getByText("Invite")).toBeInTheDocument();
    expect(screen.queryByText("user-self")).not.toBeInTheDocument();
  });

  it("invites a friend via STUDY_ROOM_INVITEE_ADD and flips the toggle to Remove access", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        FRIENDS_LIST: () => ({ ok: true, friendIds }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
        STUDY_ROOM_INVITEE_ADD: () => ({ ok: true }),
      })
    );

    renderBox();
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

  it("hides the section again when Manage access is toggled a second time", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_LIST: () => ({ ok: true, rooms: [ownRoom] }),
        FRIENDS_LIST: () => ({ ok: true, friendIds }),
        STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }),
      })
    );

    renderBox();
    await screen.findByText("My own room");

    fireEvent.click(screen.getByText("Manage access"));
    await screen.findByText("Invite");

    fireEvent.click(screen.getByText("Hide manage access"));
    expect(screen.queryByText("Invite")).not.toBeInTheDocument();
  });
});

// v3.3 Task 9: pre-join camera/mic checkboxes - mock-verified only (see StudyRoomFooter.test.tsx
// for mid-room toggle coverage, and StudyRoomPanel.test.tsx's old header comment for why real
// device/permission behavior is deferred to Task 11's two-account QA pass).
describe("StudyRoomsBox — pre-join camera/mic toggle (v3.3 Task 9)", () => {
  it("defaults both pre-join toggles to on, and passes them through to joinRoom's options", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_LIST: () => ({ ok: true, rooms: [sampleRoom] }) })
    );
    vi.mocked(studyRoomApi.joinRoom).mockResolvedValue({ token: "livekit-jwt" });

    renderBox();
    await screen.findByText("Thursday study group");

    expect(screen.getByLabelText("Join with camera on")).toBeChecked();
    expect(screen.getByLabelText("Join with mic on")).toBeChecked();

    fireEvent.click(screen.getByLabelText("Join with camera on"));
    fireEvent.click(screen.getByText("Thursday study group"));
    fireEvent.click(screen.getByRole("button", { name: "Join study room" }));

    await waitFor(() =>
      expect(videoCallClient.joinCall).toHaveBeenCalledWith("room-1", "livekit-jwt", {
        camera: false,
        microphone: true,
      })
    );
  });
});

// v3.2 Task 2: signed out, there's nothing this box can show.
describe("StudyRoomsBox — signed-out gate (v3.2 Task 2)", () => {
  it("shows an inline sign-in prompt instead of the room list when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    renderBox();

    expect(
      await screen.findByText("Sign in to create or join a study room with your friends.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
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

    renderBox();

    await screen.findByText("No study rooms yet — create one to get started.");
    expect(
      screen.queryByText("Sign in to create or join a study room with your friends.")
    ).not.toBeInTheDocument();

    resolveSelf({ ok: true, session: { user: { id: "user-self" } } });
    await waitFor(() =>
      expect(
        screen.queryByText("Sign in to create or join a study room with your friends.")
      ).not.toBeInTheDocument()
    );
  });
});
