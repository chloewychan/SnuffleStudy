import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { supabase } from "./supabaseClient";
import { deleteAccount } from "./accountApi";

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

// supabase-js's SupabaseClient.functions is a GETTER that constructs a brand-new FunctionsClient
// on every access - mirrors tempPasscodeApi.test.ts's/coachingApi.test.ts's identical mockInvoke
// helper/comment exactly (spying on `supabase.functions.invoke` directly would silently miss the
// real call, since accountApi.ts reads the getter again and gets a different instance).
function mockInvoke(impl: (...args: unknown[]) => Promise<unknown>) {
  const invokeMock = vi.fn(impl);
  vi.spyOn(supabase, "functions", "get").mockReturnValue({ invoke: invokeMock } as never);
  return invokeMock;
}

describe("accountApi.deleteAccount", () => {
  it("invokes delete-account with no body, then clears the local session", async () => {
    const invokeMock = mockInvoke(() => Promise.resolve({ data: { ok: true }, error: null }));
    const signOutSpy = vi.spyOn(supabase.auth, "signOut").mockResolvedValue({ error: null } as never);

    await deleteAccount();

    expect(invokeMock).toHaveBeenCalledWith("delete-account");
    expect(signOutSpy).toHaveBeenCalled();
  });

  it("throws when the Edge Function returns a logical error, without signing out", async () => {
    const invokeMock = mockInvoke(() =>
      Promise.resolve({ data: { ok: false, error: "Server error" }, error: null })
    );
    const signOutSpy = vi.spyOn(supabase.auth, "signOut").mockResolvedValue({ error: null } as never);

    await expect(deleteAccount()).rejects.toThrow("Server error");

    expect(invokeMock).toHaveBeenCalled();
    expect(signOutSpy).not.toHaveBeenCalled();
  });

  it("throws when the invoke call itself errors (network failure, non-2xx)", async () => {
    mockInvoke(() => Promise.resolve({ data: null, error: { message: "Failed to send a request" } }));

    await expect(deleteAccount()).rejects.toThrow("Failed to send a request");
  });

  it("still resolves if the local sign-out itself fails (best-effort, account is already gone)", async () => {
    mockInvoke(() => Promise.resolve({ data: { ok: true }, error: null }));
    vi.spyOn(supabase.auth, "signOut").mockRejectedValue(new Error("local session already gone"));

    await expect(deleteAccount()).resolves.toBeUndefined();
  });
});
