// Covers messageRouter.ts's Task 5 additions (AUTH_*/FRIEND_* cases) in isolation from the main
// messageRouter.test.ts suite. Spies on the supabaseClient singleton's `.auth` methods and on
// friendshipApi's exported functions (this repo's established test style - see
// friendshipApi.test.ts and OptionsApp.test.tsx's vi.spyOn(messenger, "sendMessage")) so these
// cases are verified to route to the right underlying call with the right arguments, entirely
// offline - no real network call is ever made.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as friendshipApi from "../infrastructure/backend/friendshipApi";
import type { Friendship, InviteCode } from "../infrastructure/backend/friendshipApi";
import * as nudgeApi from "../infrastructure/backend/nudgeApi";
import type { FriendNudge } from "../infrastructure/backend/nudgeApi";
import * as friendRequestApi from "../infrastructure/backend/friendRequestApi";
import type { FriendRequest } from "../domain/accountability/friendRequest";
import * as digestApi from "../infrastructure/backend/digestApi";
import type { DigestSummary } from "../infrastructure/backend/digestApi";
import * as accountApi from "../infrastructure/backend/accountApi";
import * as profileApi from "../infrastructure/backend/profileApi";
import type { Profile } from "../infrastructure/backend/profileApi";
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

  // v3.3 Task 14: password auth.
  it("AUTH_SET_PASSWORD calls updateUser with the given password", async () => {
    const spy = vi.spyOn(supabase.auth, "updateUser").mockResolvedValue({
      data: { user: { id: "user-a" } },
      error: null,
    } as never);

    const result = (await handleMessage({
      type: "AUTH_SET_PASSWORD",
      payload: { password: "correct-horse-battery-staple" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith({ password: "correct-horse-battery-staple" });
    expect(result).toEqual({ ok: true });
  });

  it("AUTH_SET_PASSWORD surfaces a Supabase error as ok:false", async () => {
    vi.spyOn(supabase.auth, "updateUser").mockResolvedValue({
      data: { user: null },
      error: { message: "Password should be at least 6 characters" },
    } as never);

    const result = (await handleMessage({
      type: "AUTH_SET_PASSWORD",
      payload: { password: "x" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Password should be at least 6 characters" });
  });

  it("AUTH_SIGN_IN_PASSWORD calls signInWithPassword with the given email/password", async () => {
    const fakeSession = { access_token: "tok", user: { id: "user-a" } };
    const spy = vi.spyOn(supabase.auth, "signInWithPassword").mockResolvedValue({
      data: { session: fakeSession, user: fakeSession.user },
      error: null,
    } as never);

    const result = (await handleMessage({
      type: "AUTH_SIGN_IN_PASSWORD",
      payload: { email: "a@example.com", password: "correct-horse-battery-staple" },
    })) as { ok: boolean; session: unknown };

    expect(spy).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "correct-horse-battery-staple",
    });
    expect(result).toEqual({ ok: true, session: fakeSession });
  });

  it("AUTH_SIGN_IN_PASSWORD surfaces a Supabase error (e.g. wrong password) as ok:false", async () => {
    vi.spyOn(supabase.auth, "signInWithPassword").mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Invalid login credentials" },
    } as never);

    const result = (await handleMessage({
      type: "AUTH_SIGN_IN_PASSWORD",
      payload: { email: "a@example.com", password: "wrong" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Invalid login credentials" });
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

describe("messageRouter — FRIEND_* (v3.4 Task 2 - replaces GROUP_*)", () => {
  it("FRIEND_INVITE_GENERATE_CODE calls friendshipApi.generateInviteCode with no arguments (Decision 2: no groupId)", async () => {
    const inviteCode: InviteCode = {
      code: "ABCD1234",
      createdBy: "user-a",
      expiresAt: 1_736_294_400_000,
      usedBy: null,
    };
    const spy = vi.spyOn(friendshipApi, "generateInviteCode").mockResolvedValue(inviteCode);

    const result = (await handleMessage({
      type: "FRIEND_INVITE_GENERATE_CODE",
    })) as { ok: boolean; inviteCode: InviteCode };

    expect(spy).toHaveBeenCalledWith();
    expect(result).toEqual({ ok: true, inviteCode });
  });

  it("FRIEND_INVITE_GENERATE_CODE propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(friendshipApi, "generateInviteCode").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "FRIEND_INVITE_GENERATE_CODE",
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("FRIEND_REDEEM_CODE calls friendshipApi.redeemInviteCode with the given code", async () => {
    const friendship: Friendship = {
      userIdA: "user-a",
      userIdB: "user-b",
      initiatedBy: "user-a",
      createdAt: 1_735_689_600_000,
    };
    const spy = vi.spyOn(friendshipApi, "redeemInviteCode").mockResolvedValue(friendship);

    const result = (await handleMessage({
      type: "FRIEND_REDEEM_CODE",
      payload: { code: "CODE1234" },
    })) as { ok: boolean; friendship: Friendship };

    expect(spy).toHaveBeenCalledWith("CODE1234");
    expect(result).toEqual({ ok: true, friendship });
  });

  it("FRIEND_REDEEM_CODE propagates a thrown error as ok:false (e.g. expired/already-used code)", async () => {
    vi.spyOn(friendshipApi, "redeemInviteCode").mockRejectedValue(
      new Error("Invite code not found, expired, or already used.")
    );

    const result = (await handleMessage({
      type: "FRIEND_REDEEM_CODE",
      payload: { code: "STALE123" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Invite code not found, expired, or already used." });
  });

  it("FRIENDS_LIST calls friendshipApi.listMyFriends", async () => {
    const friendIds = ["user-b", "user-c"];
    const spy = vi.spyOn(friendshipApi, "listMyFriends").mockResolvedValue(friendIds);

    const result = (await handleMessage({ type: "FRIENDS_LIST" })) as {
      ok: boolean;
      friendIds: string[];
    };

    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, friendIds });
  });

  it("FRIENDS_LIST propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(friendshipApi, "listMyFriends").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({ type: "FRIENDS_LIST" })) as {
      ok: boolean;
      error?: string;
    };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("FRIEND_REMOVE calls friendshipApi.removeFriend with the given friendUserId", async () => {
    const spy = vi.spyOn(friendshipApi, "removeFriend").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "FRIEND_REMOVE",
      payload: { friendUserId: "user-b" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("user-b");
    expect(result).toEqual({ ok: true });
  });

  it("FRIEND_REMOVE propagates a thrown error as ok:false (e.g. not actually friends)", async () => {
    vi.spyOn(friendshipApi, "removeFriend").mockRejectedValue(
      new Error("You aren't friends with this user.")
    );

    const result = (await handleMessage({
      type: "FRIEND_REMOVE",
      payload: { friendUserId: "user-stranger" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "You aren't friends with this user." });
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

// v3.4 Task 3: was "messageRouter — UNLOCK_REQUEST_*" (unlockRequestApi.ts) - retargeted to the
// consolidated friendRequestApi.ts/FRIEND_REQUEST_* messages, exercised here with
// kind: "site_unlock" (site_temp_pass/session_end coverage lives in
// messageRouterTempPasscode.test.ts/messageRouterSessionEnd.test.ts, retargeted the same way).
describe("messageRouter — FRIEND_REQUEST_* (site_unlock)", () => {
  const sampleRequest: FriendRequest = {
    id: "req-1",
    kind: "site_unlock",
    sessionId: "session-1",
    requesterUserId: "user-a",
    friendUserId: null,
    message: null,
    hostname: "youtube.com",
    status: "pending",
    requestedAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: null,
  };

  it("FRIEND_REQUEST_CREATE calls friendRequestApi.createRequest with the given kind/sessionId/hostname", async () => {
    const spy = vi.spyOn(friendRequestApi, "createRequest").mockResolvedValue(sampleRequest);

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CREATE",
      payload: { kind: "site_unlock", sessionId: "session-1", hostname: "youtube.com" },
    })) as { ok: boolean; request: FriendRequest };

    expect(spy).toHaveBeenCalledWith("site_unlock", {
      kind: "site_unlock",
      sessionId: "session-1",
      hostname: "youtube.com",
    });
    expect(result).toEqual({ ok: true, request: sampleRequest });
  });

  it("FRIEND_REQUEST_CREATE propagates a thrown error as ok:false (outer handleMessage catch)", async () => {
    vi.spyOn(friendRequestApi, "createRequest").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_CREATE",
      payload: { kind: "site_unlock", sessionId: "session-1", hostname: "youtube.com" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("FRIEND_REQUEST_RESOLVE calls friendRequestApi.resolveRequest with the given requestId/decision", async () => {
    const spy = vi.spyOn(friendRequestApi, "resolveRequest").mockResolvedValue(undefined);

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_RESOLVE",
      payload: { requestId: "req-1", decision: "approved" },
    })) as { ok: boolean };

    expect(spy).toHaveBeenCalledWith("req-1", "approved");
    expect(result).toEqual({ ok: true });
  });

  it("FRIEND_REQUEST_RESOLVE propagates a thrown error as ok:false (e.g. first-responder-wins denial)", async () => {
    vi.spyOn(friendRequestApi, "resolveRequest").mockRejectedValue(
      new Error("Could not resolve this request — it may already have been resolved.")
    );

    const result = (await handleMessage({
      type: "FRIEND_REQUEST_RESOLVE",
      payload: { requestId: "req-1", decision: "approved" },
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already have been resolved");
  });

  it("FRIEND_REQUESTS_FETCH calls friendRequestApi.fetchRelevantRequests with the given sinceTimestamp", async () => {
    const spy = vi
      .spyOn(friendRequestApi, "fetchRelevantRequests")
      .mockResolvedValue([sampleRequest]);

    const result = (await handleMessage({
      type: "FRIEND_REQUESTS_FETCH",
      payload: { sinceTimestamp: 12345 },
    })) as { ok: boolean; requests: FriendRequest[] };

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

describe("messageRouter — PROFILE_* (v3.3 Task 8)", () => {
  const sampleProfile: Profile = {
    userId: "user-a",
    humanName: "Alice",
    bunnyName: "Fluffball",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("PROFILE_GET_MINE calls profileApi.getMyProfile and returns its result", async () => {
    const spy = vi.spyOn(profileApi, "getMyProfile").mockResolvedValue(sampleProfile);

    const result = (await handleMessage({ type: "PROFILE_GET_MINE" })) as {
      ok: boolean;
      profile: Profile;
    };

    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, profile: sampleProfile });
  });

  it("PROFILE_GET_MINE returns profile: null (not an error) when no row exists yet", async () => {
    vi.spyOn(profileApi, "getMyProfile").mockResolvedValue(null);

    const result = (await handleMessage({ type: "PROFILE_GET_MINE" })) as {
      ok: boolean;
      profile: Profile | null;
    };

    expect(result).toEqual({ ok: true, profile: null });
  });

  it("PROFILE_GET_MINE propagates a thrown error as ok:false (e.g. not signed in)", async () => {
    vi.spyOn(profileApi, "getMyProfile").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({ type: "PROFILE_GET_MINE" })) as {
      ok: boolean;
      error?: string;
    };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("PROFILE_SAVE_MINE calls profileApi.saveMyProfile with the given patch", async () => {
    const spy = vi.spyOn(profileApi, "saveMyProfile").mockResolvedValue(sampleProfile);

    const result = (await handleMessage({
      type: "PROFILE_SAVE_MINE",
      payload: { humanName: "Alice", bunnyName: "Fluffball" },
    })) as { ok: boolean; profile: Profile };

    expect(spy).toHaveBeenCalledWith({ humanName: "Alice", bunnyName: "Fluffball" });
    expect(result).toEqual({ ok: true, profile: sampleProfile });
  });

  it("PROFILE_SAVE_MINE propagates a thrown error as ok:false", async () => {
    vi.spyOn(profileApi, "saveMyProfile").mockRejectedValue(new Error("Not signed in."));

    const result = (await handleMessage({
      type: "PROFILE_SAVE_MINE",
      payload: { humanName: "Alice" },
    })) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: false, error: "Not signed in." });
  });

  it("PROFILES_FETCH_BY_IDS calls profileApi.fetchProfilesByIds with the given userIds", async () => {
    const spy = vi.spyOn(profileApi, "fetchProfilesByIds").mockResolvedValue([sampleProfile]);

    const result = (await handleMessage({
      type: "PROFILES_FETCH_BY_IDS",
      payload: { userIds: ["user-a", "user-stranger"] },
    })) as { ok: boolean; profiles: Profile[] };

    expect(spy).toHaveBeenCalledWith(["user-a", "user-stranger"]);
    expect(result).toEqual({ ok: true, profiles: [sampleProfile] });
  });

  it("PROFILES_FETCH_BY_IDS returns ok:true with [] when fetchProfilesByIds degrades to [] (never throws)", async () => {
    vi.spyOn(profileApi, "fetchProfilesByIds").mockResolvedValue([]);

    const result = (await handleMessage({
      type: "PROFILES_FETCH_BY_IDS",
      payload: { userIds: ["user-stranger"] },
    })) as { ok: boolean; profiles: Profile[] };

    expect(result).toEqual({ ok: true, profiles: [] });
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
