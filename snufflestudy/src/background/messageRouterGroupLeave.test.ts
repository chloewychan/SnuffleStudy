// Covers messageRouter.ts's v2 follow-up (Item 2, post-final-review) GROUP_LEAVE case, mirroring
// messageRouterProducerTags.test.ts's own convention exactly: spies on friendGroupApi's exported
// leaveGroup (this repo's established test style for a thin message-router pass-through) so this
// case is verified to route to the right underlying call with the right arguments, entirely
// offline - no real network call is ever made. There is no pre-existing messageRouter test file
// for the other GROUP_* cases (GROUP_CREATE/GROUP_JOIN/etc. are covered only via
// friendGroupApi.test.ts's unit tests and scripts/verify-rls.mjs's live checks), so this is a new
// file rather than an addition to an existing GROUP_* suite.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import * as friendGroupApi from "../infrastructure/backend/friendGroupApi";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe("messageRouter — GROUP_LEAVE", () => {
  it("calls friendGroupApi.leaveGroup with groupId and no targetUserId for a self-leave", async () => {
    const spy = vi.spyOn(friendGroupApi, "leaveGroup").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "GROUP_LEAVE",
      payload: { groupId: "group-1" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("group-1", undefined);
    expect(result).toEqual({ ok: true });
  });

  it("calls friendGroupApi.leaveGroup with groupId and targetUserId when an owner removes a specific member", async () => {
    const spy = vi.spyOn(friendGroupApi, "leaveGroup").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "GROUP_LEAVE",
      payload: { groupId: "group-1", targetUserId: "member-to-remove" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("group-1", "member-to-remove");
    expect(result).toEqual({ ok: true });
  });

  it("propagates a thrown error as ok:false (outer handleMessage catch), same convention as every other GROUP_* case", async () => {
    vi.spyOn(friendGroupApi, "leaveGroup").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "GROUP_LEAVE",
      payload: { groupId: "group-1" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });
});
