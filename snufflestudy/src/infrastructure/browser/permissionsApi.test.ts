import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  hasDetailedTrackingPermission,
  requestDetailedTrackingPermission,
  revokeDetailedTrackingPermission,
  requestHardBlockHostPermission,
} from "./permissionsApi";

// The installed @webext-core/fake-browser version has no working
// chrome.permissions implementation: chrome.permissions.contains/request/remove
// fall through to the scaffold's notMockedFunction() and throw synchronously.
// Stub a minimal in-memory implementation that tracks granted origin strings
// across calls, matching the shape hasDetailedTrackingPermission/
// requestDetailedTrackingPermission/revokeDetailedTrackingPermission rely on.
function createFakePermissions() {
  const granted = new Set<string>();
  return {
    contains: vi.fn(async ({ origins = [] }: chrome.permissions.Permissions) =>
      origins.every((o) => granted.has(o)),
    ),
    request: vi.fn(async ({ origins = [] }: chrome.permissions.Permissions) => {
      origins.forEach((o) => granted.add(o));
      return true;
    }),
    remove: vi.fn(async ({ origins = [] }: chrome.permissions.Permissions) => {
      origins.forEach((o) => granted.delete(o));
      return true;
    }),
  };
}

let fakePermissions: ReturnType<typeof createFakePermissions>;

beforeEach(() => {
  fakeBrowser.reset();
  // Re-applied every test (rather than once at module scope) so each test gets
  // a fresh, empty `granted` set — fakeBrowser.reset() doesn't touch this stub.
  fakePermissions = createFakePermissions();
  vi.stubGlobal("chrome", { ...chrome, permissions: fakePermissions });
});

describe("permissionsApi", () => {
  it("reports no detailed tracking permission by default", async () => {
    expect(await hasDetailedTrackingPermission()).toBe(false);
  });

  it("grants and then reports detailed tracking permission", async () => {
    await requestDetailedTrackingPermission();
    expect(await hasDetailedTrackingPermission()).toBe(true);
  });

  it("revokes detailed tracking permission", async () => {
    await requestDetailedTrackingPermission();
    await revokeDetailedTrackingPermission();
    expect(await hasDetailedTrackingPermission()).toBe(false);
  });

  it("requests host permission for every site's origins in a single call", async () => {
    const granted = await requestHardBlockHostPermission(["youtube.com", "reddit.com"]);

    expect(granted).toBe(true);
    expect(fakePermissions.request).toHaveBeenCalledTimes(1);
    expect(
      await fakePermissions.contains({
        origins: [
          "*://youtube.com/*",
          "*://*.youtube.com/*",
          "*://reddit.com/*",
          "*://*.reddit.com/*",
        ],
      })
    ).toBe(true);
  });

  it("returns true without calling chrome.permissions.request for an empty hostname list", async () => {
    const granted = await requestHardBlockHostPermission([]);

    expect(granted).toBe(true);
    expect(fakePermissions.request).not.toHaveBeenCalled();
  });
});
