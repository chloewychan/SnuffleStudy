import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { supabase } from "../infrastructure/backend/supabaseClient";
import * as sessionStatusSyncApi from "../infrastructure/backend/sessionStatusSyncApi";
import type { SessionEventType } from "../domain/session/sessionTypes";

// Shared by messageRouter.ts (v1 lifecycle transition hook points) and alarmHandlers.ts
// (natural-completion path, which never routes through messageRouter.ts - see that file's own
// comment) so both files gate against Supabase identically instead of duplicating the check.
const settingsRepo = new ChromeStorageRepository();

// Cheap eligibility check for "is friend-sync worth attempting at all right now" - checked
// local UserSettings first (bails before ever touching Supabase), then
// supabase.auth.getSession() (see sessionStatusSyncApi.ts's currentUserId() for why getSession()
// rather than getUser() here - this runs on every session lifecycle transition, and the Task 6
// brief requires a signed-out/opted-out user to pay zero network cost, not just have the
// resulting error caught). Returns the current user's id when eligible, null otherwise - never
// throws.
export async function currentFriendSyncUserId(): Promise<string | null> {
  const settings = await settingsRepo.getSettings();
  if (!settings.friendSyncEnabled) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) return null;
    return data.session.user.id;
  } catch (err) {
    console.error("Failed to check auth session for friend sync", err);
    return null;
  }
}

// Whether the given (already-authenticated) user belongs to at least one friend group -
// group_memberships' "members can read memberships of their own groups" RLS policy (supabase/
// migrations/20260815000002_v2_rls_policies.sql) is satisfied by a user's own row, so this plain
// filtered select works without any special-cased policy. Used to decide whether the
// friend-poll alarm is worth running at all (per docs/Draft1_Architecture_Overview.md: "only
// run the alarm while there is an active session with friend features enabled" - being signed
// in and opted in with no group yet has nothing to poll for).
export async function isInAnyGroup(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("group_memberships")
      .select("group_id")
      .eq("user_id", userId)
      .limit(1);
    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch (err) {
    console.error("Failed to check group membership for friend sync", err);
    return false;
  }
}

// Fire-and-forget wrapper around sessionStatusSyncApi.recordStatusEvent, gated by
// currentFriendSyncUserId() so a signed-out/opted-out user's session transitions never touch
// Supabase at all. Never throws and is never awaited by callers - matches this codebase's
// existing best-effort patterns (e.g. alarmHandlers.ts's markBreakdownItemCompleted call,
// CompletionScreen.tsx's count fetch): a sync failure must never prevent the local session
// state transition it's attached to from succeeding. displayLabel must always be a generic,
// non-identifying string - never a raw hostname/goal text (see session_status_events'
// display_label column comment in the schema migration; per-field privacy opt-in is Task 10's
// scope, not built yet).
export function recordFriendStatusEvent(
  type: SessionEventType,
  sessionId: string,
  displayLabel: string
): void {
  currentFriendSyncUserId()
    .then((userId) => {
      if (!userId) return undefined;
      return sessionStatusSyncApi.recordStatusEvent({ type, sessionId, displayLabel });
    })
    .catch((err) => console.error("Failed to sync session status event to friends", err));
}
