import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real WebRTC/LiveKit connections aren't testable in this environment (no camera/mic, no actual
// signaling server) - per this task's brief, this mocks livekit-client entirely and tests only
// videoCallClient.ts's own connect/disconnect/event-forwarding logic around it. Mirrors this
// codebase's other vi.mock(...) module-boundary tests (e.g.
// src/content/overlay/SnufflesOverlay.test.tsx mocking coachingApi.ts).
//
// FakeRoom is a minimal stand-in for livekit-client's real `Room` class: an event emitter
// (on/off/emit) plus the handful of methods/properties videoCallClient.ts actually calls
// (connect, disconnect, localParticipant.setCameraEnabled/setMicrophoneEnabled/identity).
// Instances are tracked on the class itself (FakeRoom.instances) so tests can reach into whichever
// instance joinCall() constructed internally - videoCallClient.ts never exposes the Room instance
// itself (per the isolation requirement), so this is test-only reflection, not something the real
// module surface offers. setCameraEnabled defaults to resolving a fake published track (so the
// "local video tile" path is exercised by default, matching the real SDK's normal happy path);
// individual tests override it per-instance via mockResolvedValueOnce/mockRejectedValueOnce where
// they need different behavior.
type Listener = (...args: unknown[]) => void;

vi.mock("livekit-client", () => {
  // Shared, mutable across FakeRoom instances - read at CALL time (not construction time) by
  // every instance's setCameraEnabled, so a test can flip this before a specific joinCall() and
  // have it apply to whichever instance that call constructs, without needing to reach into the
  // instance before it exists.
  let cameraShouldFail = false;

  class FakeRoom {
    static instances: FakeRoom[] = [];
    static setCameraShouldFail(value: boolean) {
      cameraShouldFail = value;
    }
    private listeners: Record<string, Listener[]> = {};
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    localParticipant = {
      identity: "local-user",
      setCameraEnabled: vi.fn().mockImplementation(() =>
        cameraShouldFail
          ? Promise.reject(new Error("Permission denied"))
          : Promise.resolve({ track: { attach: vi.fn(() => document.createElement("video")) } })
      ),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    };
    constructor() {
      FakeRoom.instances.push(this);
    }
    on(event: string, cb: Listener) {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    off(event: string, cb: Listener) {
      this.listeners[event] = (this.listeners[event] ?? []).filter((fn) => fn !== cb);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      ParticipantDisconnected: "participantDisconnected",
      Disconnected: "disconnected",
    },
  };
});

import { Room } from "livekit-client";
import { joinCall, leaveCall, onVideoCallEvent } from "./videoCallClient";

// Cast to reach the test-only `instances` static the mock factory above adds - the real
// livekit-client `Room` class has no such thing, so this is deliberately typed against the fake
// shape rather than the real one.
const FakeRoomClass = Room as unknown as {
  instances: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    localParticipant: {
      identity: string;
      setCameraEnabled: ReturnType<typeof vi.fn>;
      setMicrophoneEnabled: ReturnType<typeof vi.fn>;
    };
    emit: (event: string, ...args: unknown[]) => void;
  }>;
  setCameraShouldFail: (value: boolean) => void;
};

function latestRoom() {
  const room = FakeRoomClass.instances[FakeRoomClass.instances.length - 1];
  if (!room) throw new Error("No FakeRoom instance was constructed");
  return room;
}

function fakeTrack(element: HTMLMediaElement) {
  return { attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
}

beforeEach(() => {
  FakeRoomClass.instances.length = 0;
  FakeRoomClass.setCameraShouldFail(false);
  vi.stubEnv("WXT_LIVEKIT_URL", "wss://fake.livekit.cloud");
});

afterEach(() => {
  // Defensive cleanup so a failed assertion mid-test doesn't leave a "joined" call for the next
  // test - mirrors this module's own leaveCall() being explicitly safe to call when idle.
  leaveCall();
  vi.unstubAllEnvs();
});

describe("videoCallClient.joinCall", () => {
  it("connects to WXT_LIVEKIT_URL with the given token, and publishes local camera+mic", async () => {
    await joinCall("room-1", "livekit-jwt");

    const room = latestRoom();
    expect(room.connect).toHaveBeenCalledWith("wss://fake.livekit.cloud", "livekit-jwt");
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("emits a local track-added event once the camera track publishes", async () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const unsubscribe = onVideoCallEvent((event) => events.push(event as never));

    await joinCall("room-1", "livekit-jwt");

    const localEvents = events.filter((e) => e.type === "track-added" && e.isLocal === true);
    expect(localEvents).toHaveLength(1);
    const localEvent = localEvents[0]!;
    expect(localEvent).toMatchObject({ participantIdentity: "local-user", isLocal: true });
    expect(localEvent.element).toBeInstanceOf(HTMLVideoElement);

    unsubscribe();
  });

  it("throws when WXT_LIVEKIT_URL is not configured, and never constructs a Room", async () => {
    vi.stubEnv("WXT_LIVEKIT_URL", "");

    await expect(joinCall("room-1", "livekit-jwt")).rejects.toThrow("Video calling is not configured");
    expect(FakeRoomClass.instances).toHaveLength(0);
  });

  it("still joins successfully when the camera fails to publish (graceful degradation)", async () => {
    FakeRoomClass.setCameraShouldFail(true);

    await expect(joinCall("room-1", "livekit-jwt")).resolves.toBeUndefined();

    const room = latestRoom();
    expect(room.connect).toHaveBeenCalled();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("defensively leaves a previous call before joining a new one", async () => {
    await joinCall("room-1", "token-1");
    const firstRoom = latestRoom();

    await joinCall("room-2", "token-2");

    expect(firstRoom.disconnect).toHaveBeenCalled();
    expect(FakeRoomClass.instances).toHaveLength(2);
  });
});

describe("videoCallClient.leaveCall", () => {
  it("disconnects the active room", async () => {
    await joinCall("room-1", "livekit-jwt");
    const room = latestRoom();

    leaveCall();

    expect(room.disconnect).toHaveBeenCalled();
  });

  it("is a safe no-op when no call is active", () => {
    expect(() => leaveCall()).not.toThrow();
  });
});

describe("videoCallClient remote-track event forwarding", () => {
  it("forwards trackSubscribed as a track-added event with the attached element", async () => {
    await joinCall("room-1", "livekit-jwt");
    const room = latestRoom();

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const unsubscribe = onVideoCallEvent((event) => events.push(event as never));

    const element = document.createElement("video");
    const track = fakeTrack(element);
    const participant = { identity: "friend-b" };
    room.emit("trackSubscribed", track, { kind: "video" }, participant);

    expect(track.attach).toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "track-added",
      participantIdentity: "friend-b",
      isLocal: false,
      element,
    });

    unsubscribe();
  });

  it("forwards trackUnsubscribed as a track-removed event for each detached element", async () => {
    await joinCall("room-1", "livekit-jwt");
    const room = latestRoom();

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const unsubscribe = onVideoCallEvent((event) => events.push(event as never));

    const element = document.createElement("video");
    const track = fakeTrack(element);
    const participant = { identity: "friend-b" };
    room.emit("trackUnsubscribed", track, { kind: "video" }, participant);

    expect(track.detach).toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "track-removed",
      participantIdentity: "friend-b",
      isLocal: false,
      element,
    });

    unsubscribe();
  });

  it("forwards participantDisconnected", async () => {
    await joinCall("room-1", "livekit-jwt");
    const room = latestRoom();

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const unsubscribe = onVideoCallEvent((event) => events.push(event as never));

    room.emit("participantDisconnected", { identity: "friend-b" });

    expect(events).toContainEqual({ type: "participant-disconnected", participantIdentity: "friend-b" });
    unsubscribe();
  });

  it("forwards disconnected", async () => {
    await joinCall("room-1", "livekit-jwt");
    const room = latestRoom();

    const events: Array<{ type: string }> = [];
    const unsubscribe = onVideoCallEvent((event) => events.push(event));

    room.emit("disconnected");

    expect(events).toContainEqual({ type: "disconnected" });
    unsubscribe();
  });

  it("stops delivering events to a listener once unsubscribed", async () => {
    await joinCall("room-1", "livekit-jwt");
    const room = latestRoom();

    const events: unknown[] = [];
    const unsubscribe = onVideoCallEvent((event) => events.push(event));
    unsubscribe();

    room.emit("disconnected");

    expect(events).toHaveLength(0);
  });
});
