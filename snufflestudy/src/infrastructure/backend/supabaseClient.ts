import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Structurally matches supabase-js's `SupportedStorage` interface (an async Storage adapter -
// getItem/setItem/removeItem returning Promises). Not imported from @supabase/supabase-js
// because that type isn't part of its public export surface; duck-typing it here is
// sufficient since createClient only checks shape, not identity.
interface AsyncStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// MV3 service workers have no `window`/`localStorage`, which is what supabase-js's auth
// module defaults to for persisting the session. Without an explicit adapter, `persistSession:
// true` would throw (or silently no-op, depending on version) the moment the service worker
// tries to read/write a session. chrome.storage.local is the MV3-safe equivalent - mirrors
// ChromeStorageRepository's style of wrapping chrome.storage.local.get/set (see
// ../storage/chromeStorageRepository.ts). The background service worker is where this session
// needs to live, since later tasks (6-14) drive backend syncs from background-side
// alarms/idle listeners, not from UI components - see messageRouter.ts, which imports the
// `supabase` singleton below rather than each UI surface creating its own client.
export const chromeStorageAuthAdapter: AsyncStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const result = await chrome.storage.local.get<Record<string, string>>(key);
    return result[key] ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  },
};

let cachedClient: SupabaseClient | null = null;

// Constructs the real client on first use, not at module-evaluation time. This matters
// concretely: entrypoints/background.ts statically imports messageRouter.ts, which statically
// imports this module. createClient() throws synchronously if the URL/anon key are falsy
// (missing/misconfigured .env - a fresh clone, or CI with no secrets provisioned) - if that
// throw happened at module load, it would propagate through those static imports and take down
// the *entire* background service worker before registerAlarmHandlers/registerTabHandlers/
// registerIdleHandlers/registerActivityTrackingHandlers ever ran, breaking all local session
// functionality, not just the backend-dependent auth/group features. That directly violates the
// v2 constraint that a friend-group feature failing to sync must never block starting or
// running a local session. Deferring construction to first actual property access means a
// missing/bad config only fails whichever specific AUTH_*/GROUP_* message tried to use it
// (caught by messageRouter.ts's top-level try/catch in handleMessage, same as any other thrown
// error there), never module load.
function getRealClient(): SupabaseClient {
  if (!cachedClient) {
    // import.meta.env.WXT_* is exposed to the client bundle by WXT's Vite config (envPrefix
    // includes "WXT_") - safe to ship here because this is the anon key, which is meaningless
    // without RLS (the actual enforcement mechanism; see supabase/migrations/
    // 20260815000002_v2_rls_policies.sql) backing every table it can touch. This is the only
    // Supabase key allowed anywhere under src/ - SUPABASE_SERVICE_ROLE_KEY must never appear
    // here.
    const url = import.meta.env.WXT_SUPABASE_URL;
    const anonKey = import.meta.env.WXT_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Error(
        "Supabase is not configured (WXT_SUPABASE_URL / WXT_SUPABASE_ANON_KEY missing) - " +
          "backend-dependent features are unavailable, but local sessions are unaffected."
      );
    }
    cachedClient = createClient(url, anonKey, {
      auth: {
        storage: chromeStorageAuthAdapter,
        autoRefreshToken: true,
        persistSession: true,
        // The default (true) tries to read window.location for a magic-link redirect flow -
        // there's no redirect URL flow here (auth uses signInWithOtp + verifyOtp's 6-digit code
        // path, not the clickable link - see friendGroupApi.ts's neighboring auth flow in
        // messageRouter.ts), and window doesn't exist in an MV3 service worker anyway, so this
        // must be explicitly false rather than left to default.
        detectSessionInUrl: false,
      },
    });
  }
  return cachedClient;
}

// A Proxy that looks and behaves exactly like a SupabaseClient to every existing call site
// (messageRouter.ts's `supabase.auth.signInWithOtp(...)`, friendGroupApi.ts's
// `supabase.from(...)`, etc. are all unchanged), but defers actually constructing the real
// client - and therefore any construction-time throw - until the first property is read off
// it. Function-valued properties are bound to the real client so `const { from } = supabase`
// -style destructuring (not used today, but not assumed against) still works.
//
// The extra traps beyond `get` exist for one reason: this codebase's tests mock the Supabase
// boundary via `vi.spyOn(supabase, "from")` / `vi.spyOn(supabase.auth, "getUser")` (see
// friendGroupApi.test.ts) rather than `vi.mock`, and vitest's spyOn (tinyspy) needs to read a
// property descriptor for "from" before it can temporarily replace it - `.from` lives on
// SupabaseClient's prototype (not as an own instance property, unlike `.auth`), so without a
// `getPrototypeOf` trap forwarding to the real client's prototype, tinyspy's own
// prototype-chain walk would search this Proxy's empty placeholder target instead and fail
// with "The property is not defined on the object."
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(target, prop, _receiver) {
    // A property explicitly set on the proxy's own (otherwise-empty) target - e.g. by
    // vi.spyOn/tinyspy temporarily replacing a method via Object.defineProperty for a test -
    // takes precedence over the real client, exactly like own-property shadowing on a normal
    // object. Without this check, a spied-on mock would be defined but never actually read.
    if (Object.prototype.hasOwnProperty.call(target, prop)) {
      return Reflect.get(target, prop);
    }
    const client = getRealClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(target, prop) {
    if (Object.prototype.hasOwnProperty.call(target, prop)) return true;
    return Reflect.has(getRealClient(), prop);
  },
  getOwnPropertyDescriptor(target, prop) {
    if (Object.prototype.hasOwnProperty.call(target, prop)) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(getRealClient(), prop);
    if (!descriptor) return undefined;
    // Proxy invariant: getOwnPropertyDescriptor may only report a non-configurable property if
    // an identical one actually exists on the proxy's own target. Mirroring the descriptor onto
    // the target (forcing configurable: true) satisfies that invariant, and is also exactly
    // what lets vi.spyOn's subsequent Object.defineProperty(supabase, prop, mock) succeed.
    const mirrored = { ...descriptor, configurable: true };
    Object.defineProperty(target, prop, mirrored);
    return mirrored;
  },
  getPrototypeOf() {
    // Lets tinyspy's own-property-then-prototype-chain walk find prototype methods like
    // `.from`/`.rpc`/`.channel` (see the comment above the Proxy) by handing back the real
    // client's actual prototype instead of this placeholder target's (Object.prototype).
    return Reflect.getPrototypeOf(getRealClient());
  },
});
