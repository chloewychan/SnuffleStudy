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
// 32-symbol alphabet is ~40 bits of entropy (32^8), short enough to type, long enough that
// brute-forcing an unexpired code against `invite_codes`' RLS-gated read policy isn't
// practical. Alphabet excludes visually-ambiguous characters (0/O, 1/I/L) since these codes
// are meant to be read/typed by a human.
const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// The plan doesn't specify an invite code lifetime - 7 days is a reasonable default for "share
// this with a friend to join your group" without leaving stale codes readable indefinitely
// (invite_codes' RLS select policy already restricts reads to unexpired+unused rows).
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

export async function joinGroup(code: string): Promise<GroupMembership> {
  const userId = await requireUserId();

  // invite_codes' "unexpired unused codes are readable" RLS policy already restricts this
  // SELECT to rows where expires_at > now() and used_by is null - an expired or already-used
  // code simply isn't visible, so this comes back empty/erroring rather than needing an
  // explicit expiry check here.
  const { data: invite, error: inviteError } = await supabase
    .from("invite_codes")
    .select()
    .eq("code", code)
    .single();
  if (inviteError || !invite) {
    throw new Error("Invite code not found, expired, or already used.");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("group_memberships")
    .insert({ group_id: invite.group_id, user_id: userId })
    .select()
    .single();
  if (membershipError || !membership) {
    throw new Error(membershipError?.message ?? "Failed to join group.");
  }

  // Marks the code redeemed. This must run as the joining user's own authenticated session
  // (never service-role) - invite_codes' "unused unexpired codes can be redeemed once" RLS
  // policy's WITH CHECK requires used_by = auth.uid(), so a service-role write (which has no
  // auth.uid()) would fail this check, and a different user's session couldn't satisfy it
  // either.
  const { error: updateError } = await supabase
    .from("invite_codes")
    .update({ used_by: userId })
    .eq("code", code);
  if (updateError) {
    throw new Error(updateError.message);
  }

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
