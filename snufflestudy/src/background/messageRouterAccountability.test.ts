// Covers messageRouter.ts's Task 5 additions (AUTH_*/GROUP_* cases) in isolation from the main
// messageRouter.test.ts suite. Spies on the supabaseClient singleton's `.auth` methods and on
// friendGroupApi's exported functions (this repo's established test style - see
// friendGroupApi.test.ts and OptionsApp.test.tsx's vi.spyOn(messenger, "sendMessage")) so these
// cases are verified to route to the right underlying call with the right arguments, entirely
// offline - no real network call is ever made.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleMessage } from "./messageRouter";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as friendGroupApi from "../infrastructure/backend/friendGroupApi";
import type { FriendGroup, GroupMembership, InviteCode } from "../infrastructure/backend/friendGroupApi";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

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
});
