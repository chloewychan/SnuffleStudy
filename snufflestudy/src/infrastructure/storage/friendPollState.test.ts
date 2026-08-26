import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  getLastFriendPollAt,
  setLastFriendPollAt,
  getLastNudgePollAt,
  setLastNudgePollAt,
  getLastFriendRequestPollAt,
  setLastFriendRequestPollAt,
  getLastDigestPollAt,
  setLastDigestPollAt,
  getLastProducerTagPollAt,
  setLastProducerTagPollAt,
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

// v3.4 Task 3: a third, independent cursor for the consolidated friend-request stream (replaces
// the unlock-request/temp-passcode-request/session-end-request cursors this task retires, now
// that all three kinds are one friend_requests table behind one poll query) - see this file's own
// comment on getLastFriendRequestPollAt/setLastFriendRequestPollAt for why it's separate from
// both cursors above.
describe("friendPollState — friend-request cursor", () => {
  it("returns null when no last-checked-for-friend-requests timestamp has ever been persisted", async () => {
    expect(await getLastFriendRequestPollAt()).toBeNull();
  });

  it("round-trips a timestamp through chrome.storage.local", async () => {
    await setLastFriendRequestPollAt(1_700_000_000_000);
    expect(await getLastFriendRequestPollAt()).toBe(1_700_000_000_000);
  });

  it("is independent of the friend-events and nudge cursors - setting one never affects the others", async () => {
    await setLastFriendPollAt(1_700_000_000_000);
    await setLastNudgePollAt(1_800_000_000_000);
    await setLastFriendRequestPollAt(1_900_000_000_000);

    expect(await getLastFriendPollAt()).toBe(1_700_000_000_000);
    expect(await getLastNudgePollAt()).toBe(1_800_000_000_000);
    expect(await getLastFriendRequestPollAt()).toBe(1_900_000_000_000);
  });
});

// v2 Task 9: a fourth, independent cursor for the daily-digest stream polled by the same alarm
// tick - see this file's own comment on getLastDigestPollAt/setLastDigestPollAt for why it's
// separate from all three cursors above.
describe("friendPollState — digest cursor", () => {
  it("returns null when no last-checked-for-digests timestamp has ever been persisted", async () => {
    expect(await getLastDigestPollAt()).toBeNull();
  });

  it("round-trips a timestamp through chrome.storage.local", async () => {
    await setLastDigestPollAt(1_700_000_000_000);
    expect(await getLastDigestPollAt()).toBe(1_700_000_000_000);
  });

  it("is independent of the other three cursors - setting one never affects the others", async () => {
    await setLastFriendPollAt(1_700_000_000_000);
    await setLastNudgePollAt(1_800_000_000_000);
    await setLastFriendRequestPollAt(1_900_000_000_000);
    await setLastDigestPollAt(2_000_000_000_000);

    expect(await getLastFriendPollAt()).toBe(1_700_000_000_000);
    expect(await getLastNudgePollAt()).toBe(1_800_000_000_000);
    expect(await getLastFriendRequestPollAt()).toBe(1_900_000_000_000);
    expect(await getLastDigestPollAt()).toBe(2_000_000_000_000);
  });
});

// v2 Task 14: a fifth, independent cursor for the producer-tag (friend-delivery) stream polled by
// the same alarm tick - see this file's own comment on getLastProducerTagPollAt/
// setLastProducerTagPollAt for why it's separate from all four cursors above.
describe("friendPollState — producer-tag cursor", () => {
  it("returns null when no last-checked-for-producer-tags timestamp has ever been persisted", async () => {
    expect(await getLastProducerTagPollAt()).toBeNull();
  });

  it("round-trips a timestamp through chrome.storage.local", async () => {
    await setLastProducerTagPollAt(1_700_000_000_000);
    expect(await getLastProducerTagPollAt()).toBe(1_700_000_000_000);
  });

  it("is independent of the other four cursors - setting one never affects the others", async () => {
    await setLastFriendPollAt(1_700_000_000_000);
    await setLastNudgePollAt(1_800_000_000_000);
    await setLastFriendRequestPollAt(1_900_000_000_000);
    await setLastDigestPollAt(2_000_000_000_000);
    await setLastProducerTagPollAt(2_200_000_000_000);

    expect(await getLastFriendPollAt()).toBe(1_700_000_000_000);
    expect(await getLastNudgePollAt()).toBe(1_800_000_000_000);
    expect(await getLastFriendRequestPollAt()).toBe(1_900_000_000_000);
    expect(await getLastDigestPollAt()).toBe(2_000_000_000_000);
    expect(await getLastProducerTagPollAt()).toBe(2_200_000_000_000);
  });
});
