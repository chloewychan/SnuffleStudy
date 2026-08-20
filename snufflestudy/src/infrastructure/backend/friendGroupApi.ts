import { supabase } from "./supabaseClient";

// Row shapes returned to callers (messageRouter.ts / OptionsApp.tsx) are camelCase, mirroring
// the rest of this codebase's TS conventions, even though the underlying Postgres columns are
// snake_case (see supabase/migrations/20260815000001_v2_accountability_schema.sql).
export interface FriendGroup {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
}

export interface InviteCode {
  code: string;
  groupId: string;
  createdBy: string;
  expiresAt: string;
  usedBy: string | null;
}

export interface GroupMembership {
  groupId: string;
  userId: string;
  joinedAt: string;
}

// Invite codes are meant to be typed/read aloud/shared over chat, not pasted from a link - a
// full crypto.randomUUID() (36 chars incl. hyphens) is impractical for that. 8 chars from a
// 31-symbol alphabet is ~40 bits of entropy, short enough to type, long enough that guessing an
// outstanding code is not practical. Since the final review's Critical fix (see joinGroup below)
// the only way to test a candidate code at all is one redeem_invite_code() RPC call per guess -
// there is no listing/enumeration operation on invite_codes any more, so this entropy is now the
// whole search space rather than a formality behind a broadly-readable table. Alphabet excludes
// visually-ambiguous characters (0/O, 1/I/L) since these codes are meant to be read/typed by a
// human.
const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// The plan doesn't specify an invite code lifetime - 7 days is a reasonable default for "share
// this with a friend to join your group" without leaving stale codes redeemable indefinitely
// (redeem_invite_code() rejects anything past expires_at, and the code's creator can still see
// their own unredeemed codes via invite_codes' narrowed SELECT policy).
const INVITE_CODE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function generateInviteCodeString(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  return Array.from(bytes, (b) => INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length]).join("");
}

async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

export async function createGroup(name: string): Promise<FriendGroup> {
  const userId = await requireUserId();

  // The group's id is generated client-side (crypto.randomUUID(), same technique this
  // codebase already uses for locally-generated ids - see messageRouter.ts's local newId())
  // rather than left to the DB's default gen_random_uuid(). This matters concretely, not just
  // stylistically: friend_groups' "members can read their groups" RLS policy (see
  // supabase/migrations/20260815000002_v2_rls_policies.sql) requires a group_memberships row
  // to already exist for the reader, and Postgres enforces that same SELECT policy against an
  // INSERT statement's own RETURNING clause (which is what supabase-js's chained `.select()`
  // requests) - not just against later reads. Chaining `.insert(...).select().single()` on
  // friend_groups here would therefore fail every time: at that instant no group_memberships
  // row exists yet (it's the very next statement), so the RETURNING clause is denied and the
  // whole insert is rolled back - a chicken-and-egg RLS failure. Knowing the id up front breaks
  // the cycle: insert the group (no RETURNING needed), insert the owner's membership row using
  // that known id, and only then fetch the group back (now readable).
  //
  // Order also matters for a second reason since fix round 1: group_memberships' INSERT policy
  // (supabase/migrations/20260815000005_v2_gate_group_membership_on_invite.sql) requires either
  // a redeemed invite code OR that the friend_groups row already exists with this user as
  // owner_user_id (via the is_group_owner() helper) - so the friend_groups insert below must
  // happen first, or the owner's own membership insert would have nothing to satisfy that check
  // against either.
  //
  // Not atomic (no RPC/transaction wraps the two inserts below) - if the membership insert
  // fails after the friend_groups insert succeeds, the result is an orphaned friend_groups row
  // that's permanently unreadable (no membership row ever satisfies its SELECT policy) and this
  // function still throws, so the caller sees a failure either way; it just doesn't clean up
  // the orphan. A real fix would need a SECURITY DEFINER Postgres function called via .rpc() to
  // wrap both inserts in one transaction - noted here, not built, since it's a low-probability
  // partial-failure edge case rather than a correctness or security gap.
  const id = crypto.randomUUID();

  const { error: groupError } = await supabase
    .from("friend_groups")
    .insert({ id, name, owner_user_id: userId });
  if (groupError) {
    throw new Error(groupError.message);
  }

  const { error: membershipError } = await supabase
    .from("group_memberships")
    .insert({ group_id: id, user_id: userId });
  if (membershipError) {
    throw new Error(membershipError.message);
  }

  // Only readable now that the membership row above exists. Fetched fresh (rather than
  // approximating createdAt with the client clock) so the returned value matches the DB's
  // actual `created_at default now()`.
  const { data: group, error: fetchError } = await supabase
    .from("friend_groups")
    .select()
    .eq("id", id)
    .single();
  if (fetchError || !group) {
    throw new Error(fetchError?.message ?? "Failed to load the newly created group.");
  }

  return {
    id: group.id,
    name: group.name,
    ownerUserId: group.owner_user_id,
    createdAt: group.created_at,
  };
}

export async function generateInviteCode(groupId: string): Promise<InviteCode> {
  const userId = await requireUserId();
  const code = generateInviteCodeString();
  const expiresAt = new Date(Date.now() + INVITE_CODE_EXPIRY_MS).toISOString();

  const { data, error } = await supabase
    .from("invite_codes")
    .insert({ code, group_id: groupId, created_by: userId, expires_at: expiresAt })
    .select()
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to generate invite code.");
  }

  return {
    code: data.code,
    groupId: data.group_id,
    createdBy: data.created_by,
    expiresAt: data.expires_at,
    usedBy: data.used_by,
  };
}

// Joining is a single server-side transaction (the redeem_invite_code SECURITY DEFINER function,
// supabase/migrations/20260815000025_v2_lock_down_invite_code_redemption.sql), NOT the
// select-then-update-then-insert sequence this function used through v2's final review.
//
// That earlier sequence was only possible because invite_codes was readable and updatable by any
// authenticated client, which the final review found to be a Critical vulnerability (finding C1):
// the SELECT policy had no auth.uid() predicate at all, so a stranger could enumerate every
// outstanding code in the project along with its group_id, and the UPDATE policy checked only
// "unused and unexpired", so that same stranger could redeem any code they enumerated and then
// satisfy group_memberships' has_redeemed_invite_code() gate to insert themselves into a group
// they were never invited to. (This function's previous comment asserted the broad readability was
// intentional and safe "per the plan's own spec" - that was wrong, and is the reasoning the fix
// migration's header comment corrects at length. A code is a bearer secret: being able to READ
// someone else's code is being able to USE it.)
//
// invite_codes now grants no client UPDATE at all and only lets a user SELECT codes they created
// or personally redeemed, so neither the lookup nor the redemption can happen from here any more -
// both live inside the function, which finds the row by exact code value (the bearer secret is the
// authorization) and marks it redeemed. The membership insert moves in there too, which also
// closes the non-atomicity noted in this function's old comment: one function body is one
// transaction, so a failure can no longer burn a code without granting membership.
//
// Must run as the joining user's own authenticated session (never service-role) - the function
// reads auth.uid() internally for both the redemption and the membership row.
export async function joinGroup(code: string): Promise<GroupMembership> {
  await requireUserId();

  // Returns the resulting group_memberships row as a single JSON object (the function is
  // `returns group_memberships`, not `returns setof`/`returns table`, so PostgREST does not wrap
  // it in an array). Every failure mode - unknown code, expired code, already-redeemed code -
  // raises the same deliberately-indistinguishable exception inside the function, so a caller
  // can't use this as an oracle for whether an arbitrary code exists; that exception arrives here
  // as a normal PostgREST error and its message is already the user-facing wording this function
  // used to produce itself.
  const { data, error } = await supabase.rpc("redeem_invite_code", { p_code: code });
  if (error || !data) {
    throw new Error(error?.message ?? "Invite code not found, expired, or already used.");
  }

  const membership = data as { group_id: string; user_id: string; joined_at: string };
  return {
    groupId: membership.group_id,
    userId: membership.user_id,
    joinedAt: membership.joined_at,
  };
}

// There is no `profiles` table in this schema (see the migration files) - member identity here
// is limited to whatever group_memberships itself has, i.e. raw user_ids. Joining to
// auth.users directly isn't available to the anon/authenticated client role (auth.users is
// Postgres-internal, not exposed via PostgREST), so this returns bare user_ids. A future task
// that wants friend-facing display names would need a `profiles` table populated via a trigger
// or Edge Function - out of scope for Task 5.
export async function listMembers(groupId: string): Promise<GroupMembership[]> {
  const { data, error } = await supabase
    .from("group_memberships")
    .select()
    .eq("group_id", groupId);
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row: { group_id: string; user_id: string; joined_at: string }) => ({
    groupId: row.group_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
  }));
}

// v2 follow-up (Item 2, post-final-review): deletes the caller's own group_memberships row
// (leave), or - when targetUserId is supplied - a different member's row (a group owner removing
// someone else, i.e. a kick). Both are the exact same DELETE, just naming a different user_id; the
// new RLS policy (supabase/migrations/20260815000028_v2_group_leave.sql - "member can leave or
// owner can remove a member") is what actually decides whether the caller is allowed to remove
// THIS particular row: their own row always qualifies via `user_id = auth.uid()`, and a
// non-owner's attempt to remove someone else's row is denied server-side regardless of what this
// function passes - this function does no authorization of its own, matching every other
// function in this file (the RLS policy is the enforcement, per the Global Constraint).
//
// Same error-handling convention as createGroup/generateInviteCode/joinGroup above: throw with the
// Postgres error message when present. A denied delete (wrong user attempting to remove someone
// else) is NOT surfaced as a Postgres error here - RLS silently filters a DELETE to zero affected
// rows rather than raising, the same "silent filtering, not an error" behavior this codebase's
// verify-*.mjs scripts document repeatedly for SELECT/UPDATE. Since supabase-js's plain
// `.delete()` (no `.select()`) doesn't report affected-row count either, this function cannot
// distinguish "the row was removed" from "RLS silently allowed zero rows" purely from this call's
// result - callers that need that distinction (this dispatch's messageRouter.ts case does not)
// would need to add `.select()` and check the returned array, the same technique verify-rls.mjs's
// own DELETE checks use.
export async function leaveGroup(groupId: string, targetUserId?: string): Promise<void> {
  // requireUserId() is called unconditionally (not just in the omitted-targetUserId branch) so an
  // unauthenticated call always fails with this file's usual "Not signed in." message, matching
  // every other function here, rather than falling through to a raw RLS denial with no caller id
  // at all.
  const selfUserId = await requireUserId();

  const { error } = await supabase
    .from("group_memberships")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", targetUserId ?? selfUserId);
  if (error) {
    throw new Error(error.message);
  }
}

// v2 Task 7: same query shape as friendSync.ts's isInAnyGroup() (group_memberships filtered by
// user_id, satisfiable under "members can read memberships of their own groups" RLS without any
// special-cased policy), but returning the full rows instead of a boolean - needed by
// FriendGroupPanel.tsx to discover which group(s) the current user is in at all, so it can then
// call listMembers() per group to build a nudge-target list. Neither AccountPage.tsx nor any
// other existing code fetches "all of the current user's groups" today (AccountPage.tsx only
// ever remembers the single group it just created/joined, in local component state) - this is a
// small, natural extension of listMembers()'s existing pattern, not a rebuild of it.
export async function listMyGroups(): Promise<GroupMembership[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("group_memberships")
    .select()
    .eq("user_id", userId);
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row: { group_id: string; user_id: string; joined_at: string }) => ({
    groupId: row.group_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
  }));
}
