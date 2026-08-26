import { supabase } from "./supabaseClient";
import { requireUserId } from "./authHelpers";

// v3.3 Task 8: bunny/human display names, backed by the new `profiles` table (supabase/
// migrations/20260815000034_v3.3_profiles.sql). Row shapes returned to callers are camelCase,
// mirroring this codebase's established row->interface convention (friendGroupApi.ts's
// FriendGroup/GroupMembership, friendshipSettingsApi.ts's FriendshipSettings, etc.) even though
// the underlying Postgres columns are snake_case.
export interface Profile {
  userId: string;
  humanName: string | null;
  bunnyName: string | null;
  updatedAt: string;
  // v3.4 Task 6: durable, server-side signal for "does this account already have a password to
  // prove before changing it" - see markPasswordSet()'s own comment below and
  // background/messageRouter.ts's AUTH_SET_PASSWORD case. null means no password has ever been
  // set for this account.
  passwordSetAt: number | null;
}

interface ProfileRow {
  user_id: string;
  human_name: string | null;
  bunny_name: string | null;
  updated_at: string;
  password_set_at: string | null;
}

function toProfile(row: ProfileRow): Profile {
  return {
    userId: row.user_id,
    humanName: row.human_name,
    bunnyName: row.bunny_name,
    updatedAt: row.updated_at,
    passwordSetAt: row.password_set_at ? new Date(row.password_set_at).getTime() : null,
  };
}

// Returns null (not a throw) when the signed-in user has no profiles row yet - a real, expected
// state (no trigger auto-creates one; see the migration's header comment), not an error.
// BunnyTab.tsx's own stub-default fallback ("Snuffles"/"Hooman") is what turns this null into
// something displayable.
export async function getMyProfile(): Promise<Profile | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("profiles")
    .select()
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data ? toProfile(data as ProfileRow) : null;
}

// Upserts (not a plain update) - unlike friendship_settings (auto-created by a group_memberships
// trigger the moment two users share a group, so updateFriendshipSettings() can assume the row
// already exists), nothing pre-creates a profiles row for a new user. The very first save this
// function ever makes for a given user IS the row's creation. `onConflict: "user_id"` is explicit
// even though user_id is already the table's primary key (and therefore supabase-js's default
// conflict target), so the intent reads clearly without relying on the reader already knowing that.
//
// Both the INSERT and UPDATE paths this upsert can take are covered by RLS policies with the
// identical `user_id = auth.uid()` predicate (see the migration), and userId here always comes
// from requireUserId() (never client-supplied), so this can never write a row under anyone else's
// identity.
export async function saveMyProfile(patch: {
  humanName?: string;
  bunnyName?: string;
}): Promise<Profile> {
  const userId = await requireUserId();
  const rowPatch: Record<string, string> = {};
  if (patch.humanName !== undefined) rowPatch.human_name = patch.humanName;
  if (patch.bunnyName !== undefined) rowPatch.bunny_name = patch.bunnyName;

  const { data, error } = await supabase
    .from("profiles")
    .upsert({ user_id: userId, ...rowPatch }, { onConflict: "user_id" })
    .select()
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to save your profile.");
  }
  return toProfile(data as ProfileRow);
}

// Never throws - degrades to [] on any failure, same convention as
// unlockRequestApi.fetchRelevantUnlockRequests. A plain .select().in("user_id", userIds) with no
// client-side filtering: the "self or group-mate can read a profile" RLS policy already restricts
// what actually comes back to rows the caller is allowed to see (their own profile, or a
// group-mate's) - a stranger's id in `userIds` is silently omitted from the result, not an error
// and not a raw uuid leaking through. Callers (useDisplayNames.ts) are expected to fall back to
// the raw id for any userId that doesn't come back with a humanName.
// v3.4 Task 6: separate from saveMyProfile() deliberately - password_set_at must never be
// client-supplied (it's proof-of-state, not user-editable content like humanName/bunnyName), so it
// gets its own narrow function rather than an optional field on saveMyProfile()'s patch type, which
// would invite a caller to pass an arbitrary timestamp. Upserts (not a plain update) for the same
// reason saveMyProfile() does - a brand-new account's profiles row may not exist yet at the moment
// AUTH_SET_PASSWORD first fires (Task 7's create-account flow calls AUTH_SET_PASSWORD and
// PROFILE_SAVE_MINE together, in an order this function must not depend on).
export async function markPasswordSet(): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: userId, password_set_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) {
    throw new Error(error.message);
  }
}

export async function fetchProfilesByIds(userIds: string[]): Promise<Profile[]> {
  if (userIds.length === 0) return [];
  try {
    const { data, error } = await supabase.from("profiles").select().in("user_id", userIds);
    if (error || !data) {
      if (error) console.error("Failed to fetch profiles", error);
      return [];
    }
    return (data as ProfileRow[]).map(toProfile);
  } catch (err) {
    console.error("Failed to fetch profiles", err);
    return [];
  }
}
