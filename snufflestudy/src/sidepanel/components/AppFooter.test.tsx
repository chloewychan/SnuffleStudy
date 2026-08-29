import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppFooter } from "./AppFooter";
import { StudyRoomSessionProvider, useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";
import { RefreshRegistryProvider } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import type { StudyRoom } from "../../domain/rooms/studyRoom";

// v4.1 Task 7: AppFooter.tsx is the shell this task stands up - for now it renders
// <StudyRoomFooter /> when a room is joined, otherwise null. Task 8 widens the condition to also
// account for the Nudges & Unlock Requests half; this file only covers what Task 7 actually ships.
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

function Harness() {
  const { joinRoom } = useStudyRoomSession();
  return (
    <>
      <button type="button" onClick={() => void joinRoom(sampleRoom, { camera: true, microphone: true })}>
        Join (test harness)
      </button>
      <AppFooter />
    </>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(studyRoomApi.joinRoom).mockReset().mockResolvedValue({ token: "livekit-jwt" });
  vi.mocked(studyRoomApi.subscribeToPresence).mockReset().mockReturnValue(() => {});
  vi.mocked(videoCallClient.joinCall).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.leaveCall).mockReset();
  vi.mocked(videoCallClient.onVideoCallEvent).mockReset().mockReturnValue(() => {});
});

describe("AppFooter", () => {
  it("renders nothing when no study room is joined", () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(
      <RefreshRegistryProvider>
        <StudyRoomSessionProvider>
          <AppFooter />
        </StudyRoomSessionProvider>
      </RefreshRegistryProvider>
    );

    expect(document.querySelector(".sp-app-footer")).not.toBeInTheDocument();
  });

  it("renders the Study Room footer inside .sp-app-footer once a room is joined", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, participants: [] });

    render(
      <RefreshRegistryProvider>
        <StudyRoomSessionProvider>
          <Harness />
        </StudyRoomSessionProvider>
      </RefreshRegistryProvider>
    );

    fireEvent.click(screen.getByText("Join (test harness)"));

    await screen.findByText("Leave room");
    const footer = document.querySelector(".sp-app-footer");
    expect(footer).toBeInTheDocument();
    expect(footer).toContainElement(screen.getByRole("heading", { name: "Thursday study group" }));
  });
});
