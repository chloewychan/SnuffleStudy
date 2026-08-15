import { createClient } from "@supabase/supabase-js";

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

// import.meta.env.WXT_* is exposed to the client bundle by WXT's Vite config (envPrefix
// includes "WXT_") - safe to ship here because this is the anon key, which is meaningless
// without RLS (the actual enforcement mechanism; see supabase/migrations/
// 20260815000002_v2_rls_policies.sql) backing every table it can touch. This is the only
// Supabase key allowed anywhere under src/ - SUPABASE_SERVICE_ROLE_KEY must never appear here.
export const supabase = createClient(
  import.meta.env.WXT_SUPABASE_URL,
  import.meta.env.WXT_SUPABASE_ANON_KEY,
  {
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
  }
);
