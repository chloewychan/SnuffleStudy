import { supabase } from "./supabaseClient";

// Use for explicit, infrequent user-initiated actions (a button press) where a verified identity
// is worth the extra round trip .getUser() costs over .getSession().
export async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Use for poll-side callers that must distinguish "the auth check itself failed" (ok: false - a
// real failure, must not advance a persisted poll cursor) from "cleanly signed out" (ok: true,
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
