import { supabase } from "./supabaseClient";

// Verbatim from friendGroupApi.ts/friendshipSettingsApi.ts/producerTagApi.ts/studyRoomApi.ts/
// tempPasscodeApi.ts/unlockRequestApi.ts/sessionEndRequestApi.ts/profileApi.ts - all 8 copies are
// byte-identical, confirmed by direct comparison. For explicit, infrequent user-initiated actions
// (a button press) where a verified identity is worth the extra round trip .getUser() costs over
// .getSession().
export async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Verbatim from producerTagApi.ts/tempPasscodeApi.ts/unlockRequestApi.ts/sessionEndRequestApi.ts/
// sessionStatusSyncApi.ts/nudgeApi.ts/digestApi.ts/coachingApi.ts - all 8 copies are byte-identical.
// For poll-side callers that must distinguish "the auth check itself failed" (ok: false - a real
// failure, must not advance a persisted poll cursor) from "cleanly signed out" (ok: true,
// userId: null - not a failure, just nothing to fetch).
export async function checkAuth(): Promise<{ ok: true; userId: string | null } | { ok: false }> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.error("Failed to read Supabase auth session", error);
      return { ok: false };
    }
    return { ok: true, userId: data.session?.user.id ?? null };
  } catch (err) {
    console.error("Failed to read Supabase auth session", err);
    return { ok: false };
  }
}
