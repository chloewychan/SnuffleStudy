import { supabase } from "./supabaseClient";
import { requireUserId } from "./authHelpers";

// v3.4 Task 2: replaces friendGroupApi.ts entirely - the old group-sharing mechanic (friend_groups/
// group_memberships/invite_codes.group_id and the helper that checked shared membership) is gone,
// replaced by a direct pairwise friendships table and are_friends() (supabase/migrations/
// 20260815000040_v3.4_friendships.sql).
// Row shapes returned to callers (messageRouter.ts / UI components) are camelCase, mirroring the
// rest of this codebase's TS conventions, even though the underlying Postgres columns are
// snake_case.
export interface Friendship {
  userIdA: string;
  userIdB: string;
  initiatedBy: string;
  createdAt: number;
}

export interface InviteCode {
  code: string;
  createdBy: string;
  expiresAt: number;
  usedBy: string | null;
}

// Invite codes are meant to be typed/read aloud/shared over chat, not pasted from a link - a full
// crypto.randomUUID() (36 chars incl. hyphens) is impractical for that. 8 chars from a 31-symbol
// alphabet is ~40 bits of entropy, short enough to type, long enough that guessing an outstanding
// code is not practical. Alphabet excludes visually-ambiguous characters (0/O, 1/I/L) since these
// codes are meant to be read/typed by a human. Same alphabet/length/expiry as
// friendGroupApi.ts's old generateInviteCode() - unchanged, only the absence of a groupId param
// and the dropped group_id column on write (Decision 2).
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function generateInviteCodeString(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  return Array.from(bytes, (b) => INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length]).join("");
}

export async function generateInviteCode(): Promise<InviteCode> {
  const userId = await requireUserId();
  const code = generateInviteCodeString();

  const { data, error } = await supabase
    .from("invite_codes")
    .insert({
      code,
      created_by: userId,
      expires_at: new Date(Date.now() + INVITE_CODE_EXPIRY_MS).toISOString(),
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to generate an invite code.");
  }
  return {
    code: data.code,
    createdBy: data.created_by,
    expiresAt: new Date(data.expires_at).getTime(),
    usedBy: data.used_by,
  };
}

// Joining is a single server-side transaction (the redeem_invite_code SECURITY DEFINER function,
// supabase/migrations/20260815000040_v3.4_friendships.sql), same as friendGroupApi.ts's old
// joinGroup() - redemption now inserts a friendships row directly between the two users (Decision
// 1: instant connect, no accept/decline step) instead of a group_memberships row. Every failure
// mode - unknown code, expired code, already-redeemed code, redeeming your own code - raises the
// same exception inside the function, arriving here as a normal PostgREST error.
export async function redeemInviteCode(code: string): Promise<Friendship> {
  const { data, error } = await supabase.rpc("redeem_invite_code", { p_code: code });
  if (error || !data) {
    throw new Error(error?.message ?? "Could not redeem that invite code.");
  }
  return {
    userIdA: data.user_id_a,
    userIdB: data.user_id_b,
    initiatedBy: data.initiated_by,
    createdAt: new Date(data.created_at).getTime(),
  };
}

// Flat list of every friend's user id (self excluded) - replaces the GROUP_LIST_MINE ->
// N x GROUP_LIST_MEMBERS -> dedupe fan-out every one of the old call sites (LockedPage.tsx,
// useFriendGroupPanelData.ts's loadFriends, StudyRoomPanel.tsx's ManageAccessSection,
// AccountPage.tsx) independently implemented under the group model. RLS's "either party can read
// their friendship" policy already restricts this to the caller's own rows.
export async function listMyFriends(): Promise<string[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("friendships")
    .select("user_id_a, user_id_b")
    .or(`user_id_a.eq.${userId},user_id_b.eq.${userId}`);
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => (row.user_id_a === userId ? row.user_id_b : row.user_id_a));
}

// "Remove friend" - either party can unilaterally end the friendship (RLS: "either party can
// remove their friendship"). Chains .select() onto the delete, same convention
// friendGroupApi.ts's leaveGroup() already established: an UPDATE/DELETE matching zero rows is
// not itself a Postgres error, so without forcing a read of the (possibly zero) affected rows,
// calling this on a userId that was never actually a friend would silently "succeed" with nothing
// removed.
export async function removeFriend(friendUserId: string): Promise<void> {
  const userId = await requireUserId();
  const a = userId < friendUserId ? userId : friendUserId;
  const b = userId < friendUserId ? friendUserId : userId;

  const { data, error } = await supabase
    .from("friendships")
    .delete()
    .eq("user_id_a", a)
    .eq("user_id_b", b)
    .select();
  if (error) {
    throw new Error(error.message);
  }
  if (!data || data.length === 0) {
    throw new Error("You aren't friends with this user.");
  }
}
