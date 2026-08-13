import { describe, it, expect, vi, beforeEach } from "vitest";
import contentScriptModule from "./index";
import * as messenger from "../infrastructure/messaging/extensionMessenger";
import * as overlayHost from "./overlay/overlayHost";
import type { StudySession } from "../domain/session/sessionTypes";

// defineContentScript is an identity function in WXT (see wxt/dist/utils/define-content-script),
// so the default export's `main` is directly callable here without a real content-script host.
// Its declared type expects a ContentScriptContext argument (unused by this implementation),
// so we cast rather than fabricate one.
const runMain = () => (contentScriptModule.main as unknown as () => Promise<void>)();

function fakeSession(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "session-1",
    goal: "Finish problem set",
    state: "FOCUSING",
    interventionLevel: "none",
    activityState: "active",
    createdAt: Date.now(),
    focusDurationSeconds: 1500,
    breakDurationSeconds: 300,
    pressureProfileId: "strict-coach",
    allowedSites: [],
    restrictedSites: [],
    restrictionMode: "soft",
    accountabilityUserIds: [],
    distractionAttempts: 0,
    recoveries: 0,
    friendNudges: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("content script main()", () => {
  it("does not mount when there is no active session", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    const mountSpy = vi.spyOn(overlayHost, "mount");

    await runMain();

    expect(mountSpy).not.toHaveBeenCalled();
  });

  it("does not mount when the active session is not FOCUSING", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: fakeSession({ state: "PAUSED" }),
    });
    const mountSpy = vi.spyOn(overlayHost, "mount");

    await runMain();

    expect(mountSpy).not.toHaveBeenCalled();
  });

  it("mounts the overlay with the site classification when a FOCUSING session is active", async () => {
    const session = fakeSession();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session };
      if (message.type === "SITE_STATUS_REQUEST") return { ok: true, classification: "BLOCKED" };
      throw new Error(`unexpected message ${message.type}`);
    });
    const mountSpy = vi.spyOn(overlayHost, "mount").mockImplementation(() => {});

    await runMain();

    expect(mountSpy).toHaveBeenCalledWith({
      classification: "BLOCKED",
      sessionId: session.id,
    });
  });

  it("silently no-ops instead of throwing when sendMessage rejects", async () => {
    // Content scripts run in the page context: an unhandled rejection here would spam the
    // user's browser console on every page load if the background service worker is asleep.
    // This must resolve, not reject, and must not attempt to mount the overlay.
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    const mountSpy = vi.spyOn(overlayHost, "mount");

    await expect(runMain()).resolves.toBeUndefined();
    expect(mountSpy).not.toHaveBeenCalled();
  });
});
