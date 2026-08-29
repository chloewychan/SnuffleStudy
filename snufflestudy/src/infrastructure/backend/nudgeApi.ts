import { supabase } from "./supabaseClient";
import { checkAuth } from "./authHelpers";
import { isValidNudgeMessageId } from "../../domain/accountability/nudgeMessages";

// Row shape returned to callers is camelCase, mirroring sessionStatusSyncApi.ts's FriendEvent /
// friendGroupApi.ts's row->interface mapping style, even though the underlying Postgres columns
// are snake_case (see supabase/migrations/20260815000007_v2_nudges.sql).
//
// v4.1 Task 1: messageId is now nullable and customBody is new (supabase/migrations/
// 20260815000046_v4.1_nudge_vault.sql's nudges_exactly_one_body check - exactly one of the two is
// ever set on a given row). A vault-authored written nudge is copied into custom_body at send
// time (Decision 1), never a live reference to nudge_vault_texts - see sendNudge()'s "vault"
// branch below.
export interface FriendNudge {
  id: string;
  senderUserId: string;
  recipientUserId: string;
  messageId: string | null;
  customBody: string | null;
  sentAt: number;
}

interface NudgeRow {
  id: string;
  sender_user_id: string;
  recipient_user_id: string;
  message_id: string | null;
  custom_body: string | null;
  sent_at: string;
}

function toFriendNudge(row: NudgeRow): FriendNudge {
  return {
    id: row.id,
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    messageId: row.message_id,
    customBody: row.custom_body,
    sentAt: new Date(row.sent_at).getTime(),
  };
}

// v4.1 Task 1: a caller of sendNudge() picks exactly one source - the existing fixed catalog
// (Decision 6: kept, not replaced - the scope doc explicitly defers removing NUDGE_MESSAGES to
// v4.2) or a Nudge Vault written text, copied into custom_body at insert time (Decision 1).
export type NudgeSource = { kind: "catalog"; messageId: string } | { kind: "vault"; vaultTextId: string };

// Sends a nudge (catalog or vault-authored, per NudgeSource) to a friend. The toggle/cooldown
// gate is entirely server-side (the `nudges` INSERT policy, routed through the can_send_nudge()
// SECURITY DEFINER function - see supabase/migrations/20260815000007_v2_nudges.sql) - this
// function never pre-checks friendship_settings or the cooldown client-side, since the plan
// requires the rejection to be enforceable even against a client that lies about its own state (a
// malicious client could always bypass a client-side check with a raw REST call; only the
// server-side gate is load-bearing).
//
// The catalog branch's only client-side check is messageId validity against the fixed catalog
// (nudgeMessages.ts) - this is cheap data-integrity validation, not a security boundary: an
// invalid messageId would just fail to match anything meaningful downstream too, but rejecting
// before even attempting the insert avoids a wasted round trip for what's always a client bug
// (a real attacker can still insert any string via a raw REST call - can_send_nudge() doesn't
// validate messageId's shape, only who's allowed to send/receive at all - that's fine, an
// unrecognized messageId is a display concern for the recipient, not a security one).
//
// The vault branch (v4.1 Task 1, Decision 1) looks up the vault text's body and copies it into
// custom_body at insert time, rather than storing a live reference to nudge_vault_texts - a sent
// nudge must keep displaying correctly for its recipient even after the sender later deletes that
// vault text. The lookup select is itself gated by nudge_vault_texts' "owner can manage their own
// vault texts" RLS policy (supabase/migrations/20260815000046_v4.1_nudge_vault.sql) - a
// vaultTextId belonging to a different user's vault returns no row, not another user's text, so
// this is a real (not merely client-trusted) ownership check.
export async function sendNudge(
  friendUserId: string,
  source: NudgeSource
): Promise<{ ok: boolean; error?: string }> {
  const auth = await checkAuth();
  if (!auth.ok) {
    return { ok: false, error: "Could not verify your sign-in status." };
  }
  if (!auth.userId) {
    return { ok: false, error: "Not signed in." };
  }

  let insertPayload: {
    sender_user_id: string;
    recipient_user_id: string;
    message_id?: string;
    custom_body?: string;
  };

  if (source.kind === "catalog") {
    if (!isValidNudgeMessageId(source.messageId)) {
      return { ok: false, error: "Not a recognized nudge message." };
    }
    insertPayload = {
      sender_user_id: auth.userId,
      recipient_user_id: friendUserId,
      message_id: source.messageId,
    };
  } else {
    const { data: vaultText, error: vaultError } = await supabase
      .from("nudge_vault_texts")
      .select("body")
      .eq("id", source.vaultTextId)
      .single();
    if (vaultError || !vaultText) {
      return { ok: false, error: "This nudge no longer exists in your vault." };
    }
    insertPayload = {
      sender_user_id: auth.userId,
      recipient_user_id: friendUserId,
      custom_body: vaultText.body,
    };
  }

  const { error } = await supabase.from("nudges").insert(insertPayload);

  if (error) {
    // RLS denies the INSERT (a toggle is off, or the cooldown is active) with a generic Postgres
    // "new row violates row-level security policy" error - it's inherently a binary allow/deny,
    // so this catch can't say *which* gate failed (can_send_nudge() itself doesn't surface that
    // either - see its comment). The friendly message below names both possibilities rather than
    // guessing.
    console.error("Failed to send nudge", error);
    return {
      ok: false,
      error:
        "Couldn't send that nudge — this friend may have nudges turned off, or you're on cooldown.",
    };
  }

  return { ok: true };
}

// Shared implementation behind fetchIncomingNudges/pollIncomingNudges below - identical split to
// sessionStatusSyncApi.ts's queryEventsSince/fetchNewEventsForFriends/pollNewEventsForFriends,
// for the same reason (see that file's comment): `ok` distinguishes "the query itself failed"
// from "it ran cleanly and found nothing new", which only matters to the poll-side caller
// (alarmHandlers.ts's friend-poll alarm, which must not advance its persisted nudge cursor past a
// failure - Task 6 fix round 1 had to add this distinction after a review caught that collapsing
// failure into an empty array silently and permanently drops events on a transient outage; built
// in here from the start rather than reintroducing that bug).
//
// Deliberately filtered to `recipient_user_id = auth.uid()` (unlike sessionStatusSyncApi's
// queryEventsSince, which trusts RLS to do all the filtering) - nudges' "sender or recipient can
// read their nudges" SELECT policy would already return the current user's sent nudges too, and
// this function is specifically the *incoming* side (what alarmHandlers.ts should notify about,
// what FriendGroupPanel.tsx should render as an incoming nudge) - it should never surface a
// nudge the current user sent to someone else.
async function queryNudgesSince(
  sinceTimestamp: number
): Promise<{ ok: boolean; nudges: FriendNudge[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, nudges: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, nudges: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const { data, error } = await supabase
      .from("nudges")
      .select()
      .eq("recipient_user_id", auth.userId)
      .gt("sent_at", new Date(sinceTimestamp).toISOString())
      .order("sent_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch incoming nudges", error);
      return { ok: false, nudges: [] };
    }
    return { ok: true, nudges: (data as NudgeRow[]).map(toFriendNudge) };
  } catch (err) {
    console.error("Failed to fetch incoming nudges", err);
    return { ok: false, nudges: [] };
  }
}

// Fetches nudges sent to the current user since sinceTimestamp. Never throws, and collapses the
// ok/nudges distinction above into a plain array - mirrors fetchNewEventsForFriends's contract:
// an on-demand UI fetch (FriendGroupPanel.tsx) has no persisted cursor to protect, so there's
// nothing for it to do differently on failure vs. "nothing new".
export async function fetchIncomingNudges(sinceTimestamp: number): Promise<FriendNudge[]> {
  const result = await queryNudgesSince(sinceTimestamp);
  return result.ok ? result.nudges : [];
}

// Poll-specific variant (mirrors sessionStatusSyncApi.ts's pollNewEventsForFriends). Returns a
// discriminated result distinguishing "confirmed empty" (`ok: true, nudges: []`) from "fetch
// failed" (`ok: false`) so alarmHandlers.ts's friend-poll alarm only advances its persisted
// last-checked-for-nudges cursor (friendPollState.ts) on a confirmed successful poll, leaving it
// untouched on failure so the next tick retries the same window instead of silently losing
// whatever nudges arrived during the outage.
export async function pollIncomingNudges(
  sinceTimestamp: number
): Promise<{ ok: true; nudges: FriendNudge[] } | { ok: false }> {
  const result = await queryNudgesSince(sinceTimestamp);
  return result.ok ? { ok: true, nudges: result.nudges } : { ok: false };
}
