import { supabase } from "./supabaseClient";

// v3.2 Task 8: Account/data deletion.
//
// Invokes the delete-account Edge Function - see that function's header comment for why the
// actual row/Storage/auth.users cleanup has to happen server-side (Storage HTTP API + Auth Admin
// API, neither reachable from the client). supabase.functions.invoke(...) automatically forwards
// the caller's bearer token, which the Edge Function uses to resolve the caller's own id - no
// user id is ever sent in this request's body, matching the Edge Function's own "no target
// parameter to misuse" self-service guarantee.
//
// On success, also clears this client's own local Supabase session (mirrors messageRouter.ts's
// AUTH_SIGN_OUT case) - the account no longer exists server-side by the time this resolves, so
// the caller's local JWT is already worthless; signing out locally just makes this extension's own
// UI reflect that immediately rather than surfacing confusing "not authenticated" errors on the
// next unrelated call. Best-effort: a failure here doesn't change the outcome the caller cares
// about (the account IS deleted at this point, regardless of whether the local sign-out succeeds).
//
// Throws on failure (network error, non-2xx response, or a logical `{ error }` body) - matches
// tempPasscodeApi.ts's approveRequest()/producerTagApi.ts's uploadTag() convention for a
// single-shot action with no graceful-degradation fallback: there is no sensible "pretend this
// worked" outcome for an account-deletion request that didn't actually delete anything.
export async function deleteAccount(): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
    "delete-account"
  );
  if (error || !data?.ok) {
    throw new Error(data?.error ?? error?.message ?? "Failed to delete your account.");
  }

  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error("Failed to clear local session after account deletion", err);
  }
}
