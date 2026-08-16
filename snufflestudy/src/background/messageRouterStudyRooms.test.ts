// Covers messageRouter.ts's v2 Task 13 fix round 1 additions (STUDY_ROOM_* cases, added when
// createRoom/listRooms/leaveRoom/listParticipants moved from being called directly by
// StudyRoomPanel.tsx to routing through messageRouter.ts - see studyRoomApi.ts's/
// StudyRoomPanel.tsx's own header comments for why), mirroring
// messageRouterAccountability.test.ts's/messageRouterTempPasscode.test.ts's own convention
// exactly: spies on studyRoomApi's exported functions (this repo's established test style) so
// these cases are verified to route to the right underlying call with the right arguments,
// entirely offline - no real network call is ever made. STUDY_ROOM_JOIN is deliberately NOT a
// message case (joinRoom stays a direct sidepanel call - see studyRoomApi.ts's header comment for
// why), so there's nothing to test here for it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import * as studyRoomApi from "../infrastructure/backend/studyRoomApi";
import type { StudyRoom, RoomParticipant } from "../domain/rooms/studyRoom";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

const sampleRoom: StudyRoom = {
  id: "room-1",
  name: "Thursday study group",
  ownerUserId: "user-a",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("messageRouter — STUDY_ROOM_*", () => {
  it("STUDY_ROOM_CREATE calls studyRoomApi.createRoom with the given name", async () => {
    const spy = vi.spyOn(studyRoomApi, "createRoom").mockResolvedValue(sampleRoom);

    const result = (await handleMessage({
      type: "STUDY_ROOM_CREATE",
      payload: { name: "Thursday study group" },
    })) as { ok: boolean; room: StudyRoom };

    expect(spy).toHaveBeenCalledWith("Thursday study group");
    expect(result).toEqual({ ok: true, room: sampleRoom });
  });

  it("STUDY_ROOM_CREATE propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(studyRoomApi, "createRoom").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "STUDY_ROOM_CREATE",
      payload: { name: "x" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("STUDY_ROOM_LIST calls studyRoomApi.listRooms", async () => {
    const spy = vi.spyOn(studyRoomApi, "listRooms").mockResolvedValue([sampleRoom]);

    const result = (await handleMessage({ type: "STUDY_ROOM_LIST" })) as {
      ok: boolean;
      rooms: StudyRoom[];
    };

    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, rooms: [sampleRoom] });
  });

  it("STUDY_ROOM_LIST propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(studyRoomApi, "listRooms").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({ type: "STUDY_ROOM_LIST" })) as {
      ok: boolean;
      error?: string;
    };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("STUDY_ROOM_LEAVE calls studyRoomApi.leaveRoom with the given roomId", async () => {
    const spy = vi.spyOn(studyRoomApi, "leaveRoom").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "STUDY_ROOM_LEAVE",
      payload: { roomId: "room-1" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("room-1");
    expect(result).toEqual({ ok: true });
  });

  it("STUDY_ROOM_LEAVE propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(studyRoomApi, "leaveRoom").mockRejectedValue(new Error("update failed"));

    const result = (await handleMessage({
      type: "STUDY_ROOM_LEAVE",
      payload: { roomId: "room-1" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "update failed" });
  });

  it("STUDY_ROOM_LIST_PARTICIPANTS calls studyRoomApi.listParticipants with the given roomId", async () => {
    const participants: RoomParticipant[] = [
      { roomId: "room-1", userId: "user-b", joinedAt: "2026-01-01T00:05:00.000Z", leftAt: null },
    ];
    const spy = vi.spyOn(studyRoomApi, "listParticipants").mockResolvedValue(participants);

    const result = (await handleMessage({
      type: "STUDY_ROOM_LIST_PARTICIPANTS",
      payload: { roomId: "room-1" },
    })) as { ok: boolean; participants: RoomParticipant[] };

    expect(spy).toHaveBeenCalledWith("room-1");
    expect(result).toEqual({ ok: true, participants });
  });

  it("STUDY_ROOM_LIST_PARTICIPANTS propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(studyRoomApi, "listParticipants").mockRejectedValue(new Error("select failed"));

    const result = (await handleMessage({
      type: "STUDY_ROOM_LIST_PARTICIPANTS",
      payload: { roomId: "room-1" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "select failed" });
  });
});
