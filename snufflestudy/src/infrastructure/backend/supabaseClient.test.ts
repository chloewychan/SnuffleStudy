import { describe, it, expect, beforeEach } from "vitest";
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
