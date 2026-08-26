// Live end-to-end proof for v3.4 Task 2's Definition of Done: pairwise friendships replace the
// old group mechanic, end to end, against the live dev Supabase project - not just inspected SQL.
//
// Standalone Node script (same style/conventions as scripts/verify-friend-sync.mjs /
// verify-rls.mjs) - reads .env via dotenv/config, not part of `npm test`.
// Run directly: node scripts/verify-friendships.mjs
//
// What it does, using three ephemeral, auto-confirmed test accounts (A, B, C):
//   1. A generates an invite code (mirrors friendshipApi.generateInviteCode - a bare
//      invite_codes insert as A's own authenticated client).
//   2. B redeems it (mirrors friendshipApi.redeemInviteCode - the redeem_invite_code RPC as B's
//      own client). Confirms the returned Friendship.initiatedBy === A.id.
//   3. Confirms both A's and B's FRIENDS_LIST-equivalent query (mirrors
//      friendshipApi.listMyFriends exactly: select user_id_a,user_id_b .or(...) as each's own
//      client) includes the other.
//   4. Confirms a friendship_settings row exists in BOTH directions with default values (auto-
//      created by the new friendships_create_friendship_settings trigger).
//   5. Confirms A's friend-poll tick would find B's connection - runs the EXACT query
//      alarmHandlers.ts's pollFriendConnectionUpdates runs (eq initiated_by, gt created_at) as
//      A's own client. This exercises the real query/RLS path; it does not invoke
//      chrome.notifications or the alarm scheduler itself (no chrome.* APIs in a Node script) -
//      see this script's own summary output for what's exercised vs. only inspected.
//   6. Negative cases for a third, unconnected account C (while the A-B friendship is still
//      live, so these prove real RLS filtering, not just "nothing exists to find"):
//        - C cannot read A's or B's profiles row (both given a real profiles row first).
//        - C's own FRIENDS_LIST includes neither A nor B.
//        - C directly querying the specific A-B friendships row gets nothing back (RLS: "either
//          party can read their friendship" - C is neither party).
//        - A direct nudges insert from C targeting A fails (are_friends(C,A) is false, so
//          can_send_nudge() denies it, so the INSERT policy's WITH CHECK fails).
//        - A direct producer_tag_sends insert from C targeting A (via a producer_tags row C
//          actually owns) fails the same way.
//   7. FRIEND_REMOVE: B removes the A-B friendship (mirrors friendshipApi.removeFriend's
//      canonical-order delete). Confirms both FRIENDS_LIST no longer include each other, and
//      confirms a subsequent nudge attempt between A and B now ALSO fails via are_friends().
//   8. A generates a second invite code and C redeems it (a fresh, independent (A, C)
//      friendship, needed since the (A, B) friendship above was just removed in step 7 - Task
//      2's own DoD wants account deletion proven against a friendship that still exists at
//      deletion time).
//   9. Account deletion: calls delete_account_data(A) then admin.auth.admin.deleteUser(A) - the
//      exact two-call sequence supabase/functions/delete-account/index.ts uses. Confirms the
//      (A, C) friendships row is gone and C's own FRIENDS_LIST no longer includes A.
//  10. Cleans up every remaining row and test account it created.
//  11. Prints a pass/fail summary and exits non-zero if anything failed.

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.WXT_SUPABASE_URL;
const ANON_KEY = process.env.WXT_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing WXT_SUPABASE_URL / WXT_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env"
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = Date.now();
const PASSWORD = `Verify-Friendships-${crypto.randomUUID()}!`;
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function createTestUser(label) {
  const email = `friendships-test-${label}-${RUN_ID}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Failed to create test user ${label}: ${error?.message}`);
  }
  return { id: data.user.id, email };
}

async function signInAs(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Failed to sign in as ${email}: ${error.message}`);
  return client;
}

function generateInviteCodeString() {
  return Array.from(
    { length: 8 },
    () => INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)]
  ).join("");
}

// Mirrors friendshipApi.generateInviteCode exactly - a bare insert as the generating user's own
// client, no groupId (Decision 2).
async function generateInviteCodeAs(client, userId) {
  const code = generateInviteCodeString();
  const { data, error } = await client
    .from("invite_codes")
    .insert({
      code,
      created_by: userId,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();
  return { data, error, code };
}

// Mirrors friendshipApi.redeemInviteCode exactly - one RPC call.
async function redeemInviteCodeAs(client, code) {
  return client.rpc("redeem_invite_code", { p_code: code });
}

// Mirrors friendshipApi.listMyFriends exactly.
async function listMyFriendsAs(client, userId) {
  const { data, error } = await client
    .from("friendships")
    .select("user_id_a, user_id_b")
    .or(`user_id_a.eq.${userId},user_id_b.eq.${userId}`);
  if (error) return { error, friendIds: null };
  return {
    error: null,
    friendIds: (data ?? []).map((row) => (row.user_id_a === userId ? row.user_id_b : row.user_id_a)),
  };
}

// Mirrors friendshipApi.removeFriend exactly - canonical (a < b) ordering.
async function removeFriendAs(client, selfId, friendId) {
  const a = selfId < friendId ? selfId : friendId;
  const b = selfId < friendId ? friendId : selfId;
  return client.from("friendships").delete().eq("user_id_a", a).eq("user_id_b", b).select();
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs in this schema have no ON DELETE CASCADE.
  await admin.from("producer_tag_sends").delete().in("sender_user_id", userIds);
  await admin.from("producer_tags").delete().in("user_id", userIds);
  await admin.from("nudges").delete().in("sender_user_id", userIds);
  await admin.from("nudges").delete().in("recipient_user_id", userIds);
  await admin.from("friendship_settings").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("friend_user_id", userIds);
  await admin.from("friendships").delete().in("user_id_a", userIds);
  await admin.from("friendships").delete().in("user_id_b", userIds);
  await admin.from("invite_codes").delete().in("created_by", userIds);
  await admin.from("profiles").delete().in("user_id", userIds);

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error && !error.message?.includes("User not found")) {
      console.error(`  Failed to delete test user ${id}: ${error.message}`);
    }
  }
  console.log("Cleanup done.");
}

async function main() {
  console.log("Creating ephemeral test accounts (A, B, C)...");
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userC.id];

  try {
    const clientA = await signInAs(userA.email);
    const clientB = await signInAs(userB.email);
    const clientC = await signInAs(userC.email);
    record("Setup: A, B, and C signed in via anon-key client", true);

    // Give A and B a real profiles row, so the later "C cannot read" negative case proves RLS
    // filtering, not merely that there was nothing to find.
    const { error: profileAErr } = await clientA
      .from("profiles")
      .insert({ user_id: userA.id, human_name: "Verify A" });
    const { error: profileBErr } = await clientB
      .from("profiles")
      .insert({ user_id: userB.id, human_name: "Verify B" });
    record(
      "Setup: A and B each write their own profiles row",
      !profileAErr && !profileBErr,
      [profileAErr, profileBErr].filter(Boolean).map((e) => e.message).join("; ") || undefined
    );

    // --- 1-2: generate + redeem ---
    const { data: inviteCode, error: inviteErr, code } = await generateInviteCodeAs(clientA, userA.id);
    record("A generates an invite code (FRIEND_INVITE_GENERATE_CODE)", !inviteErr && !!inviteCode, inviteErr?.message);

    const { data: friendshipAB, error: redeemErr } = await redeemInviteCodeAs(clientB, code);
    record("B redeems A's code (FRIEND_REDEEM_CODE)", !redeemErr && !!friendshipAB, redeemErr?.message);
    record(
      "Friendship.initiatedBy === A.id",
      friendshipAB?.initiated_by === userA.id,
      friendshipAB ? `got ${friendshipAB.initiated_by}` : "no friendship row returned"
    );

    // --- 3: FRIENDS_LIST both directions ---
    const { friendIds: aFriends, error: aFriendsErr } = await listMyFriendsAs(clientA, userA.id);
    const { friendIds: bFriends, error: bFriendsErr } = await listMyFriendsAs(clientB, userB.id);
    record(
      "A's FRIENDS_LIST includes B",
      !aFriendsErr && (aFriends ?? []).includes(userB.id),
      aFriendsErr?.message
    );
    record(
      "B's FRIENDS_LIST includes A",
      !bFriendsErr && (bFriends ?? []).includes(userA.id),
      bFriendsErr?.message
    );

    // --- 4: friendship_settings both directions, default values ---
    const { data: settingsAtoB, error: settingsAtoBErr } = await clientA
      .from("friendship_settings")
      .select()
      .eq("user_id", userA.id)
      .eq("friend_user_id", userB.id)
      .single();
    const { data: settingsBtoA, error: settingsBtoAErr } = await clientB
      .from("friendship_settings")
      .select()
      .eq("user_id", userB.id)
      .eq("friend_user_id", userA.id)
      .single();
    // receive_live_nudges/send_live_nudges/receive_daily_digest default to FALSE (not the
    // column's original `true` from 20260815000001) since migration
    // 20260815000027_v2_default_legacy_visibility_to_false.sql flipped them to match the five
    // newer share_* toggles' "most-private-by-default" column defaults - confirmed live before
    // hardcoding this, not assumed from the original schema migration alone.
    const defaultsMatch = (row) =>
      !!row &&
      row.receive_live_nudges === false &&
      row.send_live_nudges === false &&
      row.receive_daily_digest === false &&
      row.nudge_cooldown_seconds === 300;
    record(
      "friendship_settings(A -> B) auto-created with default values",
      !settingsAtoBErr && defaultsMatch(settingsAtoB),
      settingsAtoBErr?.message
    );
    record(
      "friendship_settings(B -> A) auto-created with default values",
      !settingsBtoAErr && defaultsMatch(settingsBtoA),
      settingsBtoAErr?.message
    );

    // --- 5: A's friend-poll tick (pollFriendConnectionUpdates' exact query) ---
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: pollRows, error: pollErr } = await clientA
      .from("friendships")
      .select("user_id_a, user_id_b, initiated_by, created_at")
      .eq("initiated_by", userA.id)
      .gt("created_at", since);
    const foundBInPoll = (pollRows ?? []).some(
      (r) => r.user_id_a === userB.id || r.user_id_b === userB.id
    );
    record(
      "A's friend-poll query (pollFriendConnectionUpdates' exact shape) finds B's new connection",
      !pollErr && foundBInPoll,
      pollErr?.message ?? (foundBInPoll ? undefined : "B's row not found in A's poll query")
    );

    // --- 6: negative cases for stranger C (while A-B friendship is still live) ---
    const { data: profilesForC, error: profilesForCErr } = await clientC
      .from("profiles")
      .select()
      .in("user_id", [userA.id, userB.id]);
    record(
      "C cannot read A's or B's profiles row",
      !profilesForCErr && (profilesForC ?? []).length === 0,
      profilesForCErr?.message ?? `C saw ${profilesForC?.length ?? 0} row(s)`
    );

    const { friendIds: cFriends, error: cFriendsErr } = await listMyFriendsAs(clientC, userC.id);
    record(
      "C's FRIENDS_LIST includes neither A nor B",
      !cFriendsErr && !(cFriends ?? []).includes(userA.id) && !(cFriends ?? []).includes(userB.id),
      cFriendsErr?.message
    );

    const abA = userA.id < userB.id ? userA.id : userB.id;
    const abB = userA.id < userB.id ? userB.id : userA.id;
    const { data: abRowForC, error: abRowForCErr } = await clientC
      .from("friendships")
      .select()
      .eq("user_id_a", abA)
      .eq("user_id_b", abB);
    record(
      "C cannot directly read the (A, B) friendships row",
      !abRowForCErr && (abRowForC ?? []).length === 0,
      abRowForCErr?.message ?? `C saw ${abRowForC?.length ?? 0} row(s)`
    );

    const { error: nudgeFromCErr } = await clientC
      .from("nudges")
      .insert({ sender_user_id: userC.id, recipient_user_id: userA.id, message_id: "keep-going" });
    record(
      "A direct nudges insert from C targeting A fails at the RLS layer (are_friends false)",
      !!nudgeFromCErr,
      nudgeFromCErr ? undefined : "insert unexpectedly SUCCEEDED - RLS did not block it"
    );

    const { data: cTag, error: cTagErr } = await clientC
      .from("producer_tags")
      .insert({ user_id: userC.id, audio_url: `verify/${RUN_ID}/c.webm`, duration_ms: 1000 })
      .select()
      .single();
    record("Setup: C creates a producer_tags row of their own", !cTagErr && !!cTag, cTagErr?.message);
    if (cTag) {
      const { error: tagSendFromCErr } = await clientC
        .from("producer_tag_sends")
        .insert({ tag_id: cTag.id, sender_user_id: userC.id, recipient_user_id: userA.id });
      record(
        "A direct producer_tag_sends insert from C targeting A fails at the RLS layer (are_friends false)",
        !!tagSendFromCErr,
        tagSendFromCErr ? undefined : "insert unexpectedly SUCCEEDED - RLS did not block it"
      );
    }

    // --- 7: FRIEND_REMOVE ---
    const { data: removedRows, error: removeErr } = await removeFriendAs(clientB, userB.id, userA.id);
    record(
      "B removes the A-B friendship (FRIEND_REMOVE)",
      !removeErr && (removedRows ?? []).length === 1,
      removeErr?.message
    );

    const { friendIds: aFriendsAfterRemove } = await listMyFriendsAs(clientA, userA.id);
    const { friendIds: bFriendsAfterRemove } = await listMyFriendsAs(clientB, userB.id);
    record(
      "After removal: A's FRIENDS_LIST no longer includes B",
      !(aFriendsAfterRemove ?? []).includes(userB.id)
    );
    record(
      "After removal: B's FRIENDS_LIST no longer includes A",
      !(bFriendsAfterRemove ?? []).includes(userA.id)
    );

    const { error: nudgeAfterRemoveErr } = await clientA
      .from("nudges")
      .insert({ sender_user_id: userA.id, recipient_user_id: userB.id, message_id: "keep-going" });
    record(
      "A nudge attempt to B fails once are_friends(A, B) is false again",
      !!nudgeAfterRemoveErr,
      nudgeAfterRemoveErr ? undefined : "insert unexpectedly SUCCEEDED after friendship removal"
    );

    // --- 8: fresh (A, C) friendship for the account-deletion check ---
    const { data: inviteCode2, error: inviteErr2, code: code2 } = await generateInviteCodeAs(
      clientA,
      userA.id
    );
    record("A generates a second invite code", !inviteErr2 && !!inviteCode2, inviteErr2?.message);
    const { data: friendshipAC, error: redeemErr2 } = await redeemInviteCodeAs(clientC, code2);
    record("C redeems A's second code, forming a fresh (A, C) friendship", !redeemErr2 && !!friendshipAC, redeemErr2?.message);

    // --- 9: account deletion ---
    const { error: deleteDataErr } = await admin.rpc("delete_account_data", { p_user_id: userA.id });
    record("delete_account_data(A) RPC succeeds", !deleteDataErr, deleteDataErr?.message);
    const { error: deleteUserErr } = await admin.auth.admin.deleteUser(userA.id);
    record("admin.auth.admin.deleteUser(A) succeeds", !deleteUserErr, deleteUserErr?.message);

    const { data: acRowAfterDelete, error: acRowAfterDeleteErr } = await admin
      .from("friendships")
      .select()
      .or(`user_id_a.eq.${userA.id},user_id_b.eq.${userA.id}`);
    record(
      "Deleting A's account removes the (A, C) friendships row entirely",
      !acRowAfterDeleteErr && (acRowAfterDelete ?? []).length === 0,
      acRowAfterDeleteErr?.message ?? `${acRowAfterDelete?.length ?? 0} row(s) still reference A`
    );

    const { friendIds: cFriendsAfterDelete, error: cFriendsAfterDeleteErr } = await listMyFriendsAs(
      clientC,
      userC.id
    );
    record(
      "C's own FRIENDS_LIST no longer includes A after A's account is deleted",
      !cFriendsAfterDeleteErr && !(cFriendsAfterDelete ?? []).includes(userA.id),
      cFriendsAfterDeleteErr?.message
    );
  } finally {
    // userA was already deleted above (deliberately, to prove the DoD's own deletion check) -
    // admin.auth.admin.deleteUser on an already-deleted id is handled as a non-fatal "not found"
    // inside cleanup() itself.
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Friendships verification summary ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}`);
  }
  console.log(
    failed.length === 0
      ? `\nAll ${results.length} checks passed.`
      : `\n${failed.length} of ${results.length} checks FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected script failure:", err);
  process.exit(1);
});
