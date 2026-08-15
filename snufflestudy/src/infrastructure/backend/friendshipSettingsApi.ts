import { supabase } from "./supabaseClient";

// v2 Task 10, Part A: the CRUD surface Task 7's own report flagged as missing - no
// friendship_settings row was ever created anywhere, and no API/UI existed to create or edit one.
// Rows are now auto-created (all default column values) by migration 20260815000012's
// group_memberships_create_friendship_settings trigger the moment two users share a group - see
// that migration's comment - so updateFriendshipSettings below is a plain UPDATE, not an upsert:
// by the time a user can see a friend to configure settings for at all (they share a group with
// them), the row already exists.
//
// Row shapes returned to callers are camelCase, mirroring this codebase's established row->
// interface convention (sessionStatusSyncApi.ts's FriendEvent, nudgeApi.ts's FriendNudge,
// friendGroupApi.ts's FriendGroup/GroupMembership all do the same) even though the underlying
// Postgres columns are snake_case (supabase/migrations/20260815000001_v2_accountability_schema.sql,
// extended by 20260815000012_v2_privacy_controls.sql).
export interface FriendshipSettings {
  userId: string;
  friendUserId: string;
  // Pre-existing (Task 5/7) - the nudge/digest axis, defaults true.
  receiveLiveNudges: boolean;
  sendLiveNudges: boolean;
  receiveDailyDigest: boolean;
  nudgeCooldownSeconds: number;
  // New (Task 10) - the five per-field visibility toggles, defaults false ("most-private-by-
  // default" - see the migration's comment on why these five default differently from the three
  // above).
  shareDistractionAttempts: boolean;
  shareCurrentDomain: boolean;
  shareGoalText: boolean;
  shareInterventionCount: boolean;
  shareFullHistory: boolean;
}

interface FriendshipSettingsRow {
  user_id: string;
  friend_user_id: string;
  receive_live_nudges: boolean;
  send_live_nudges: boolean;
  receive_daily_digest: boolean;
  nudge_cooldown_seconds: number;
  share_distraction_attempts: boolean;
  share_current_domain: boolean;
  share_goal_text: boolean;
  share_intervention_count: boolean;
  share_full_history: boolean;
}

function toFriendshipSettings(row: FriendshipSettingsRow): FriendshipSettings {
  return {
    userId: row.user_id,
    friendUserId: row.friend_user_id,
    receiveLiveNudges: row.receive_live_nudges,
    sendLiveNudges: row.send_live_nudges,
    receiveDailyDigest: row.receive_daily_digest,
    nudgeCooldownSeconds: row.nudge_cooldown_seconds,
    shareDistractionAttempts: row.share_distraction_attempts,
    shareCurrentDomain: row.share_current_domain,
    shareGoalText: row.share_goal_text,
    shareInterventionCount: row.share_intervention_count,
    shareFullHistory: row.share_full_history,
  };
}

// Every field a caller may patch - everything on FriendshipSettings except the two identity
// columns (userId/friendUserId), which are fixed once the row exists (the primary key) and are
// never themselves editable through this function.
export type FriendshipSettingsPatch = Partial<
  Omit<FriendshipSettings, "userId" | "friendUserId">
>;

function toRowPatch(patch: FriendshipSettingsPatch): Record<string, boolean | number> {
  const row: Record<string, boolean | number> = {};
  if (patch.receiveLiveNudges !== undefined) row.receive_live_nudges = patch.receiveLiveNudges;
  if (patch.sendLiveNudges !== undefined) row.send_live_nudges = patch.sendLiveNudges;
  if (patch.receiveDailyDigest !== undefined) row.receive_daily_digest = patch.receiveDailyDigest;
  if (patch.nudgeCooldownSeconds !== undefined) row.nudge_cooldown_seconds = patch.nudgeCooldownSeconds;
  if (patch.shareDistractionAttempts !== undefined) {
    row.share_distraction_attempts = patch.shareDistractionAttempts;
  }
  if (patch.shareCurrentDomain !== undefined) row.share_current_domain = patch.shareCurrentDomain;
  if (patch.shareGoalText !== undefined) row.share_goal_text = patch.shareGoalText;
  if (patch.shareInterventionCount !== undefined) {
    row.share_intervention_count = patch.shareInterventionCount;
  }
  if (patch.shareFullHistory !== undefined) row.share_full_history = patch.shareFullHistory;
  return row;
}

// Mirrors friendGroupApi.ts's requireUserId() exactly (.getUser(), not .getSession()) - these are
// explicit, infrequent user-initiated actions (opening the Friends settings page, toggling a
// checkbox), not a hot-path lifecycle transition, so paying getUser()'s extra round trip for a
// verified identity is fine here, same rationale as friendGroupApi.ts/unlockRequestApi.ts.
async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Every friendship_settings row the current user owns (user_id = auth.uid()) - one per friend
// they share a group with. RLS's "users manage only their own settings rows" policy (unchanged by
// this task - see the migration's header comment on why the pre-existing INSERT/UPDATE/SELECT/
// DELETE policy is deliberately left as-is) already restricts this to exactly those rows.
export async function listMyFriendshipSettings(): Promise<FriendshipSettings[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("friendship_settings")
    .select()
    .eq("user_id", userId);
  if (error) {
    throw new Error(error.message);
  }
  return (data as FriendshipSettingsRow[]).map(toFriendshipSettings);
}

// The current user's settings row toward one specific friend, or null if none exists yet (e.g.
// they don't actually share a group, so migration 20260815000012's trigger never created one).
export async function getFriendshipSettings(
  friendUserId: string
): Promise<FriendshipSettings | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("friendship_settings")
    .select()
    .eq("user_id", userId)
    .eq("friend_user_id", friendUserId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data ? toFriendshipSettings(data as FriendshipSettingsRow) : null;
}

// Updates (never inserts - see this file's header comment) the current user's settings row
// toward one friend. Deliberately chains .select().single() after the update, mirroring
// unlockRequestApi.ts's resolveRequest() convention: an UPDATE matching zero rows is not itself a
// Postgres/PostgREST error (it just silently affects nothing), which here would most likely mean
// no row exists yet for this friend (they don't share a group - the trigger never fired) rather
// than an RLS denial (RLS already restricts this to the caller's own rows, and the caller can
// always write their own row's columns once it exists). Forcing `.single()` on the result turns
// that silent no-op into a real, catchable error instead of a false "success".
export async function updateFriendshipSettings(
  friendUserId: string,
  patch: FriendshipSettingsPatch
): Promise<FriendshipSettings> {
  const userId = await requireUserId();
  const rowPatch = toRowPatch(patch);

  const { data, error } = await supabase
    .from("friendship_settings")
    .update(rowPatch)
    .eq("user_id", userId)
    .eq("friend_user_id", friendUserId)
    .select()
    .single();
  if (error || !data) {
    throw new Error(
      error?.message ??
        "Could not update these settings — you may not share a group with this friend yet."
    );
  }
  return toFriendshipSettings(data as FriendshipSettingsRow);
}
