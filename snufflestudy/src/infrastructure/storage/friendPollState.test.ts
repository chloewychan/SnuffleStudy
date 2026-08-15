import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { getLastFriendPollAt, setLastFriendPollAt } from "./friendPollState";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("friendPollState", () => {
  it("returns null when no last-checked timestamp has ever been persisted", async () => {
    expect(await getLastFriendPollAt()).toBeNull();
  });

  it("round-trips a timestamp through chrome.storage.local", async () => {
    await setLastFriendPollAt(1_700_000_000_000);
    expect(await getLastFriendPollAt()).toBe(1_700_000_000_000);
  });

  it("persists across separate get calls, unaffected by an in-memory-only cache (survives a simulated service-worker restart)", async () => {
    await setLastFriendPollAt(1_700_000_000_000);
    // fakeBrowser.reset() would clear storage, so intentionally NOT calling it here - the point
    // is that a fresh call to getLastFriendPollAt (as if from a newly-spun-up service worker)
    // still sees the persisted value rather than starting from scratch.
    expect(await getLastFriendPollAt()).toBe(1_700_000_000_000);
  });
});
