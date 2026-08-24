// Covers messageRouter.ts's Task 5 additions (AUTH_*/GROUP_* cases) in isolation from the main
// messageRouter.test.ts suite. Spies on the supabaseClient singleton's `.auth` methods and on
// friendGroupApi's exported functions (this repo's established test style - see
// friendGroupApi.test.ts and OptionsApp.test.tsx's vi.spyOn(messenger, "sendMessage")) so these
// cases are verified to route to the right underlying call with the right arguments, entirely
// offline - no real network call is ever made.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as friendGroupApi from "../infrastructure/backend/friendGroupApi";
import type { FriendGroup, GroupMembership, InviteCode } from "../infrastructure/backend/friendGroupApi";
import * as nudgeApi from "../infrastructure/backend/nudgeApi";
import type { FriendNudge } from "../infrastructure/backend/nudgeApi";
import * as unlockRequestApi from "../infrastructure/backend/unlockRequestApi";
import type { UnlockRequest } from "../infrastructure/backend/unlockRequestApi";
import * as digestApi from "../infrastructure/backend/digestApi";
import type { DigestSummary } from "../infrastructure/backend/digestApi";
import * as accountApi from "../infrastructure/backend/accountApi";
import { IndexedDbTaskRepository } from "../infrastructure/storage/taskRepository";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  indexedDB.deleteDatabase("snufflestudy-tasks");
});

function stubSession(userId: string | null) {
  vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session: userId ? ({ access_token: "tok", user: { id: userId } } as never) : null },
    error: null,
  } as never);
}

describe("messageRouter — AUTH_*", () => {
  it("AUTH_REQUEST_OTP calls signInWithOtp with the given email", async () => {
    const spy = vi.spyOn(supabase.auth, "signInWithOtp").mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    } as never);

    const result = (await handleMessage({
      type: "AUTH_REQUEST_OTP",
      payload: { email: "a@example.com" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith({ email: "a@example.com" });
    expect(result.ok).toBe(true);
  });

  it("AUTH_REQUEST_OTP surfaces a Supabase error as ok:false", async () => {
    vi.spyOn(supabase.auth, "signInWithOtp").mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "rate limited" },
    } as never);

    const result = (await handleMessage({
      type: "AUTH_REQUEST_OTP",
      payload: { email: "a@example.com" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "rate limited" });
  });

  it("AUTH_VERIFY_OTP calls verifyOtp with the email/token/type: email (code path, not the magic link)", async () => {
    const fakeSession = { access_token: "tok", user: { id: "user-a" } };
    const spy = vi.spyOn(supabase.auth, "verifyOtp").mockResolvedValue({
      data: { session: fakeSession, user: fakeSession.user },
      error: null,
    } as never);

    const result = (await handleMessage({
      type: "AUTH_VERIFY_OTP",
      payload: { email: "a@example.com", token: "123456" },
    })) as { ok: boolean; session: unknown };

    expect(spy).toHaveBeenCalledWith({ email: "a@example.com", token: "123456", type: "email" });
    expect(result).toEqual({ ok: true, session: fakeSession });
  });

  it("AUTH_VERIFY_OTP surfaces a Supabase error (e.g. wrong/expired code) as ok:false", async () => {
    vi.spyOn(supabase.auth, "verifyOtp").mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Token has expired or is invalid" },
    } as never);

    const result = (await handleMessage({
      type: "AUTH_VERIFY_OTP",
      payload: { email: "a@example.com", token: "000000" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Token has expired or is invalid" });
  });

  it("AUTH_SIGN_OUT calls signOut", async () => {
    const spy = vi.spyOn(supabase.auth, "signOut").mockResolvedValue({ error: null } as never);

    const result = (await handleMessage({ type: "AUTH_SIGN_OUT" })) as { ok: boolean };

    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("AUTH_GET_SESSION returns the current session", async () => {
    const fakeSession = { access_token: "tok", user: { id: "user-a" } };
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: fakeSession },
      error: null,
    } as never);

    const result = (await handleMessage({ type: "AUTH_GET_SESSION" })) as {
      ok: boolean;
      session: unknown;
    };

    expect(result).toEqual({ ok: true, session: fakeSession });
  });
});

describe("messageRouter — GROUP_*", () => {
  it("GROUP_CREATE calls friendGroupApi.createGroup with the given name", async () => {
    const group: FriendGroup = {
      id: "group-1",
      name: "Study Buddies",
      ownerUserId: "user-a",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const spy = vi.spyOn(friendGroupApi, "createGroup").mockResolvedValue(group);

    const result = (await handleMessage({
      type: "GROUP_CREATE",
      payload: { name: "Study Buddies" },
    })) as { ok: boolean; group: FriendGroup };

    expect(spy).toHaveBeenCalledWith("Study Buddies");
    expect(result).toEqual({ ok: true, group });
  });

  it("GROUP_CREATE propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(friendGroupApi, "createGroup").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "GROUP_CREATE",
      payload: { name: "x" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("GROUP_GENERATE_INVITE_CODE calls friendGroupApi.generateInviteCode with the given groupId", async () => {
    const inviteCode: InviteCode = {
      code: "ABCD1234",
      groupId: "group-1",
      createdBy: "user-a",
      expiresAt: "2026-01-08T00:00:00Z",
      usedBy: null,
    };
    const spy = vi.spyOn(friendGroupApi, "generateInviteCode").mockResolvedValue(inviteCode);

    const result = (await handleMessage({
      type: "GROUP_GENERATE_INVITE_CODE",
      payload: { groupId: "group-1" },
    })) as { ok: boolean; inviteCode: InviteCode };

    expect(spy).toHaveBeenCalledWith("group-1");
    expect(result).toEqual({ ok: true, inviteCode });
  });

  it("GROUP_JOIN calls friendGroupApi.joinGroup with the given code", async () => {
    const membership: GroupMembership = {
      groupId: "group-1",
      userId: "user-b",
      joinedAt: "2026-01-02T00:00:00Z",
    };
    const spy = vi.spyOn(friendGroupApi, "joinGroup").mockResolvedValue(membership);

    const result = (await handleMessage({
      type: "GROUP_JOIN",
      payload: { code: "CODE1234" },
    })) as { ok: boolean; membership: GroupMembership };

    expect(spy).toHaveBeenCalledWith("CODE1234");
    expect(result).toEqual({ ok: true, membership });
  });

  it("GROUP_LIST_MEMBERS calls friendGroupApi.listMembers with the given groupId", async () => {
    const members: GroupMembership[] = [
      { groupId: "group-1", userId: "user-a", joinedAt: "2026-01-01T00:00:00Z" },
    ];
    const spy = vi.spyOn(friendGroupApi, "listMembers").mockResolvedValue(members);

    const result = (await handleMessage({
      type: "GROUP_LIST_MEMBERS",
      payload: { groupId: "group-1" },
    })) as { ok: boolean; members: GroupMembership[] };

    expect(spy).toHaveBeenCalledWith("group-1");
    expect(result).toEqual({ ok: true, members });
  });

  it("GROUP_LIST_MINE calls friendGroupApi.listMyGroups", async () => {
    const memberships: GroupMembership[] = [
      { groupId: "group-1", userId: "user-a", joinedAt: "2026-01-01T00:00:00Z" },
      { groupId: "group-2", userId: "user-a", joinedAt: "2026-01-02T00:00:00Z" },
    ];
    const spy = vi.spyOn(friendGroupApi, "listMyGroups").mockResolvedValue(memberships);

    const result = (await handleMessage({ type: "GROUP_LIST_MINE" })) as {
      ok: boolean;
      memberships: GroupMembership[];
    };

    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, memberships });
  });

  it("GROUP_LIST_MINE propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(friendGroupApi, "listMyGroups").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({ type: "GROUP_LIST_MINE" })) as {
      ok: boolean;
      error?: string;
    };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });
});

describe("messageRouter — NUDGE_*", () => {
  it("NUDGE_SEND calls nudgeApi.sendNudge with the given friendUserId/messageId and returns its result verbatim", async () => {
    const spy = vi.spyOn(nudgeApi, "sendNudge").mockResolvedValue({ ok: true });

    const result = (await handleMessage({
      type: "NUDGE_SEND",
      payload: { friendUserId: "user-r", messageId: "keep-going" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("user-r", "keep-going");
    expect(result).toEqual({ ok: true });
  });

  it("NUDGE_SEND passes through a server-side rejection (ok:false + error) without throwing", async () => {
    vi.spyOn(nudgeApi, "sendNudge").mockResolvedValue({
      ok: false,
      error: "Couldn't send that nudge — this friend may have nudges turned off, or you're on cooldown.",
    });

    const result = (await handleMessage({
      type: "NUDGE_SEND",
      payload: { friendUserId: "user-r", messageId: "keep-going" },
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cooldown");
  });

  it("NUDGES_FETCH calls nudgeApi.fetchIncomingNudges with the given sinceTimestamp", async () => {
    const nudges: FriendNudge[] = [
      {
        id: "nudge-1",
        senderUserId: "user-s",
        recipientUserId: "user-r",
        messageId: "keep-going",
        sentAt: Date.now(),
      },
    ];
    const spy = vi.spyOn(nudgeApi, "fetchIncomingNudges").mockResolvedValue(nudges);

    const result = (await handleMessage({
      type: "NUDGES_FETCH",
      payload: { sinceTimestamp: 12345 },
    })) as { ok: boolean; nudges: FriendNudge[] };

    expect(spy).toHaveBeenCalledWith(12345);
    expect(result).toEqual({ ok: true, nudges });
  });
});

describe("messageRouter — UNLOCK_REQUEST_*", () => {
  const sampleRequest: UnlockRequest = {
    id: "req-1",
    sessionId: "session-1",
    requesterUserId: "user-a",
    hostname: "youtube.com",
    status: "pending",
    requestedAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
  };

  it("UNLOCK_REQUEST_CREATE calls unlockRequestApi.createRequest with the given sessionId/hostname", async () => {
    const spy = vi.spyOn(unlockRequestApi, "createRequest").mockResolvedValue(sampleRequest);

    const result = (await handleMessage({
      type: "UNLOCK_REQUEST_CREATE",
      payload: { sessionId: "session-1", hostname: "youtube.com" },
    })) as { ok: boolean; request: UnlockRequest };

    expect(spy).toHaveBeenCalledWith("session-1", "youtube.com");
    expect(result).toEqual({ ok: true, request: sampleRequest });
  });

  it("UNLOCK_REQUEST_CREATE propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(unlockRequestApi, "createRequest").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "UNLOCK_REQUEST_CREATE",
      payload: { sessionId: "session-1", hostname: "youtube.com" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("UNLOCK_REQUEST_RESOLVE calls unlockRequestApi.resolveRequest with the given requestId/decision", async () => {
    const spy = vi.spyOn(unlockRequestApi, "resolveRequest").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "UNLOCK_REQUEST_RESOLVE",
      payload: { requestId: "req-1", decision: "approved" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("req-1", "approved");
    expect(result).toEqual({ ok: true });
  });

  it("UNLOCK_REQUEST_RESOLVE propagates a thrown error as ok:false (e.g. first-responder-wins denial)", async () => {
    vi.spyOn(unlockRequestApi, "resolveRequest").mockRejectedValue(
      new Error("Could not resolve this request — it may already have been resolved.")
    );

    const result = (await handleMessage({
      type: "UNLOCK_REQUEST_RESOLVE",
      payload: { requestId: "req-1", decision: "approved" },
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already have been resolved");
  });

  it("UNLOCK_REQUESTS_FETCH calls unlockRequestApi.fetchRelevantUnlockRequests with the given sinceTimestamp", async () => {
    const spy = vi
      .spyOn(unlockRequestApi, "fetchRelevantUnlockRequests")
      .mockResolvedValue([sampleRequest]);

    const result = (await handleMessage({
      type: "UNLOCK_REQUESTS_FETCH",
      payload: { sinceTimestamp: 12345 },
    })) as { ok: boolean; requests: UnlockRequest[] };

    expect(spy).toHaveBeenCalledWith(12345);
    expect(result).toEqual({ ok: true, requests: [sampleRequest] });
  });
});

describe("messageRouter — DIGEST_FETCH (v2 Task 9)", () => {
  it("calls digestApi.fetchDigestForDate with the given date", async () => {
    const digests: DigestSummary[] = [
      {
        friendUserId: "user-friend",
        completedSessions: 2,
        abandonedSessions: 0,
        distractionCount: 1,
        recoveryRate: 1,
      },
    ];
    const spy = vi.spyOn(digestApi, "fetchDigestForDate").mockResolvedValue(digests);

    const result = (await handleMessage({
      type: "DIGEST_FETCH",
      payload: { date: "2026-08-14" },
    })) as { ok: boolean; digests: DigestSummary[] };

    expect(spy).toHaveBeenCalledWith("2026-08-14");
    expect(result).toEqual({ ok: true, digests });
  });

  it("returns ok:true with an empty digests array when fetchDigestForDate resolves to []  (signed out / nothing for that date - never throws)", async () => {
    vi.spyOn(digestApi, "fetchDigestForDate").mockResolvedValue([]);

    const result = (await handleMessage({
      type: "DIGEST_FETCH",
      payload: { date: "2026-08-14" },
    })) as { ok: boolean; digests: DigestSummary[] };

    expect(result).toEqual({ ok: true, digests: [] });
  });
});

// QA-discovered bug (v3.2): tasks used to have no account scoping at all - every account (and
// signed-out use) on a device shared the exact same task list, and account deletion could never
// reach them (local IndexedDB, not Supabase - see taskRepository.ts's own header comment).
describe("messageRouter — TASK_* is scoped to the signed-in account", () => {
  it("TASK_LIST only returns the current account's own tasks, not another account's", async () => {
    stubSession("user-a");
    const createdA = (await handleMessage({
      type: "TASK_CREATE",
      payload: { title: "A's task" },
    })) as { task: { userId: string | null } };
    expect(createdA.task.userId).toBe("user-a");

    stubSession("user-b");
    await handleMessage({ type: "TASK_CREATE", payload: { title: "B's task" } });

    const listedForB = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { title: string }[];
    };
    expect(listedForB.tasks.map((t) => t.title)).toEqual(["B's task"]);

    stubSession("user-a");
    const listedForA = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { title: string }[];
    };
    expect(listedForA.tasks.map((t) => t.title)).toEqual(["A's task"]);
  });

  it("signed-out tasks are their own scope, invisible to any signed-in account and vice versa", async () => {
    stubSession(null);
    await handleMessage({ type: "TASK_CREATE", payload: { title: "Signed-out task" } });

    stubSession("user-a");
    const listedForA = (await handleMessage({ type: "TASK_LIST" })) as { tasks: unknown[] };
    expect(listedForA.tasks).toEqual([]);

    stubSession(null);
    const listedSignedOut = (await handleMessage({ type: "TASK_LIST" })) as {
      tasks: { title: string }[];
    };
    expect(listedSignedOut.tasks.map((t) => t.title)).toEqual(["Signed-out task"]);
  });
});

describe("messageRouter — AUTH_DELETE_ACCOUNT clears that account's local tasks", () => {
  it("removes only the deleted account's own tasks - other accounts' and signed-out tasks survive", async () => {
    stubSession("user-a");
    await handleMessage({ type: "TASK_CREATE", payload: { title: "A's task" } });
    stubSession("user-b");
    await handleMessage({ type: "TASK_CREATE", payload: { title: "B's task" } });
    stubSession(null);
    await handleMessage({ type: "TASK_CREATE", payload: { title: "Signed-out task" } });

    stubSession("user-a");
    vi.spyOn(accountApi, "deleteAccount").mockResolvedValue(undefined);

    const result = (await handleMessage({ type: "AUTH_DELETE_ACCOUNT" })) as { ok: boolean };
    expect(result.ok).toBe(true);

    // Verified directly at the storage layer, not just "TASK_LIST for user-a is now empty" -
    // that alone wouldn't distinguish "actually deleted" from "current user just changed."
    const repo = new IndexedDbTaskRepository();
    expect(await repo.list("user-a")).toEqual([]);
    expect((await repo.list("user-b")).map((t) => t.title)).toEqual(["B's task"]);
    expect((await repo.list(null)).map((t) => t.title)).toEqual(["Signed-out task"]);
  });

  it("still reports ok:true even if the local task cleanup itself fails (the account is already gone server-side)", async () => {
    stubSession("user-a");
    await handleMessage({ type: "TASK_CREATE", payload: { title: "A's task" } });

    vi.spyOn(accountApi, "deleteAccount").mockResolvedValue(undefined);
    vi.spyOn(IndexedDbTaskRepository.prototype, "deleteAllForUser").mockRejectedValue(
      new Error("IndexedDB unavailable")
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = (await handleMessage({ type: "AUTH_DELETE_ACCOUNT" })) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});
