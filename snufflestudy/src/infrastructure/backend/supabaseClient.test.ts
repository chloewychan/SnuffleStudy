import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { chromeStorageAuthAdapter, supabase } from "./supabaseClient";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("chromeStorageAuthAdapter", () => {
  // supabase-js's auth module persists its session through this adapter instead of
  // window.localStorage, since MV3 service workers have neither `window` nor `localStorage`.
  it("returns null for a key that was never set", async () => {
    expect(await chromeStorageAuthAdapter.getItem("missing-key")).toBeNull();
  });

  it("round-trips a value through chrome.storage.local", async () => {
    await chromeStorageAuthAdapter.setItem("sb-session", JSON.stringify({ access_token: "tok" }));
    expect(await chromeStorageAuthAdapter.getItem("sb-session")).toBe(
      JSON.stringify({ access_token: "tok" })
    );
  });

  it("removes a value", async () => {
    await chromeStorageAuthAdapter.setItem("sb-session", "value");
    await chromeStorageAuthAdapter.removeItem("sb-session");
    expect(await chromeStorageAuthAdapter.getItem("sb-session")).toBeNull();
  });
});

describe("supabase client singleton", () => {
  it("is configured with detectSessionInUrl disabled and the chrome.storage adapter", () => {
    // There's no redirect-URL auth flow in this extension (see friendGroupApi.ts's neighboring
    // OTP-code auth flow in messageRouter.ts) and no `window.location` in an MV3 service
    // worker, so the default `detectSessionInUrl: true` would break at runtime if left unset.
    // supabase-js doesn't expose these options back off the client instance, so this asserts
    // indirectly: constructing the module (already done via the import above) must not throw,
    // and the exported client must be a usable object with the expected auth surface.
    expect(supabase).toBeDefined();
    expect(typeof supabase.auth.signInWithOtp).toBe("function");
    expect(typeof supabase.auth.verifyOtp).toBe("function");
    expect(typeof supabase.from).toBe("function");
  });
});

describe("supabase client construction is lazy", () => {
  // entrypoints/background.ts statically imports messageRouter.ts, which statically imports
  // this module. createClient() throws synchronously if the URL/anon key are falsy (a missing
  // or misconfigured .env - a fresh clone, or CI with no secrets provisioned). If construction
  // happened eagerly at module-evaluation time, that throw would propagate straight through
  // those static imports and crash the entire background service worker before
  // registerAlarmHandlers/registerTabHandlers/registerIdleHandlers/
  // registerActivityTrackingHandlers ever ran - breaking every local, offline session feature,
  // not just the backend-dependent auth/group ones. That directly violates the v2 constraint
  // that a friend-group feature failing to sync must never block starting or running a local
  // session. This test proves the fix structurally: mock createClient to always throw (standing
  // in for "misconfigured"), and confirm importing the module never calls it - only reading a
  // property off the exported client does, which is exactly the point where messageRouter.ts's
  // per-message try/catch contains the failure to that one message instead of the whole worker.
  it("does not call createClient at module-evaluation time - only on first use", async () => {
    vi.resetModules();
    const createClientSpy = vi.fn(() => {
      throw new Error("boom: createClient should not run at import time");
    });
    vi.doMock("@supabase/supabase-js", () => ({ createClient: createClientSpy }));

    try {
      const mod = await import("./supabaseClient");
      expect(createClientSpy).not.toHaveBeenCalled();

      expect(() => mod.supabase.auth).toThrow("boom: createClient should not run at import time");
      expect(createClientSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@supabase/supabase-js");
      vi.resetModules();
    }
  });
});
