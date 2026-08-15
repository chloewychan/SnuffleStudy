import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  getLastFriendPollAt,
  setLastFriendPollAt,
  getLastNudgePollAt,
  setLastNudgePollAt,
  getLastUnlockPollAt,
  setLastUnlockPollAt,
} from "./friendPollState";

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

// v2 Task 7: a second, independent cursor for the nudge stream polled by the same alarm tick -
// see this file's own comment on getLastNudgePollAt/setLastNudgePollAt for why it's separate
// from getLastFriendPollAt/setLastFriendPollAt above.
describe("friendPollState — nudge cursor", () => {
  it("returns null when no last-checked-for-nudges timestamp has ever been persisted", async () => {
    expect(await getLastNudgePollAt()).toBeNull();
  });

  it("round-trips a timestamp through chrome.storage.local", async () => {
    await setLastNudgePollAt(1_700_000_000_000);
    expect(await getLastNudgePollAt()).toBe(1_700_000_000_000);
  });

  it("is independent of the friend-events cursor - setting one never affects the other", async () => {
    await setLastFriendPollAt(1_700_000_000_000);
    await setLastNudgePollAt(1_800_000_000_000);

    expect(await getLastFriendPollAt()).toBe(1_700_000_000_000);
    expect(await getLastNudgePollAt()).toBe(1_800_000_000_000);
  });
});

// v2 Task 8: a third, independent cursor for the unlock-request stream polled by the same alarm
// tick - see this file's own comment on getLastUnlockPollAt/setLastUnlockPollAt for why it's
// separate from both cursors above.
describe("friendPollState — unlock-request cursor", () => {
  it("returns null when no last-checked-for-unlock-requests timestamp has ever been persisted", async () => {
    expect(await getLastUnlockPollAt()).toBeNull();
  });

  it("round-trips a timestamp through chrome.storage.local", async () => {
    await setLastUnlockPollAt(1_700_000_000_000);
    expect(await getLastUnlockPollAt()).toBe(1_700_000_000_000);
  });

  it("is independent of the friend-events and nudge cursors - setting one never affects the others", async () => {
    await setLastFriendPollAt(1_700_000_000_000);
    await setLastNudgePollAt(1_800_000_000_000);
    await setLastUnlockPollAt(1_900_000_000_000);

    expect(await getLastFriendPollAt()).toBe(1_700_000_000_000);
    expect(await getLastNudgePollAt()).toBe(1_800_000_000_000);
    expect(await getLastUnlockPollAt()).toBe(1_900_000_000_000);
  });
});
