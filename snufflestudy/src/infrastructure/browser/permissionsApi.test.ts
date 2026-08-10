import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  hasDetailedTrackingPermission,
  requestDetailedTrackingPermission,
  revokeDetailedTrackingPermission,
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

beforeEach(() => {
  fakeBrowser.reset();
  // Re-applied every test (rather than once at module scope) so each test gets
  // a fresh, empty `granted` set — fakeBrowser.reset() doesn't touch this stub.
  vi.stubGlobal("chrome", { ...chrome, permissions: createFakePermissions() });
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
});
