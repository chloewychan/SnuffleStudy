// Live end-to-end proof for Task 7's Definition of Done: "a nudge sent from one account respects
// the recipient's toggle (blocked entirely if off) and the cooldown (a second nudge within the
// window is rejected server-side, not just hidden client-side)." A mocked unit test (see
// src/infrastructure/backend/nudgeApi.test.ts) can only prove sendNudge() calls the right
// table/columns and translates a Postgres error into `{ ok: false }` - it can't prove the live
// database's RLS policy + can_send_nudge() function (supabase/migrations/
// 20260815000007_v2_nudges.sql) actually gate sends the way they claim to. This script proves
// that against the live project.
//
// Standalone Node script (same style/conventions as scripts/verify-rls.mjs and
// scripts/verify-friend-sync.mjs) - reads .env via dotenv/config, not part of `npm test`. Run
// directly: node scripts/verify-nudges.mjs
//
// What it does:
//   1. Creates three ephemeral, auto-confirmed accounts S (sender), R (recipient), and C (a
//      stranger S shares no group with - fix round 1's addition, see step 2 below) via the
//      service-role admin API, signs in as each via the anon-key client (password auth), so
//      every write below goes through the same RLS-bound client nudgeApi.ts's sendNudge() would
//      use.
//   2. Fix round 1 (v2 Task 10 fix round 1, supabase/migrations/
//      20260815000013_v2_tighten_friendship_settings_insert.sql): before any group is created,
//      confirms S cannot INSERT a friendship_settings row toward C, a stranger they share no
//      group with - the negative case for that migration's tightened INSERT policy. Then creates
//      a shared group for S and R (mirroring scripts/verify-rls.mjs's/verify-friend-sync.mjs's/
//      verify-digest.mjs's identical adaptation to migration 20260815000012's auto-create
//      trigger) - required for every write below this point, since the trigger now auto-creates
//      both directions of the (S, R) settings row the instant they share a group, and the
//      tightened INSERT policy means a plain `.insert()` toward R would otherwise be denied
//      outright (not just collide with the trigger's row).
//   4. Case 1 (positive): S enables send_live_nudges toward R, R enables receive_live_nudges
//      toward S with a shortened cooldown (COOLDOWN_SECONDS below, so this script never needs to
//      sleep for the real default of 300s) - a nudge from S to R succeeds.
//   5. Case 2: R turns receive_live_nudges off - the next nudge from S to R is rejected.
//   6. Case 3: R turns receive_live_nudges back on, S turns send_live_nudges off - the next
//      nudge from S to R is rejected.
//   7. Case 4: S turns send_live_nudges back on - a second nudge sent immediately (within the
//      cooldown window) is rejected. Fix round 1: this case runs after ~7 sequential network
//      round trips of setup/assertion following case 1's nudge insert, so COOLDOWN_SECONDS must
//      stay comfortably larger than that cumulative round-trip latency against a real hosted
//      Supabase instance, or this case can intermittently false-pass (the window elapses before
//      the assertion runs, so the second send wrongly succeeds instead of being rejected) for
//      reasons that have nothing to do with whether the underlying SQL is actually correct. The
//      elapsed wall-clock time since case 1's insert is logged right before this case's
//      assertion specifically so a future flake here is diagnosable rather than silently
//      misleading.
//   8. Case 5: the service-role client rewrites that nudge's sent_at to (COOLDOWN_SECONDS + 1)s
//      in the past (simulated elapsed time, per this task's instruction to avoid actually
//      sleeping in the script) - a subsequent nudge from S to R now succeeds.
//   9. Fix round (Important #1, supabase/migrations/20260815000029_v2_nudges_require_shared_group.sql):
//      Case 6 - case 5's nudge is backdated the same way, then S leaves the shared group with R
//      entirely (both toggles left untouched, still on) - confirms live that
//      users_share_a_group(S, R) is now false, then a nudge from S to R is rejected purely on the
//      missing shared group. This is the exact live-confirmed review scenario: two users who once
//      shared a group can no longer keep nudging each other forever after one of them leaves.
//  10. Cleans up every row it created and all three test accounts via the service-role client.
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
// Ephemeral, discarded at cleanup - never reused, never printed.
const PASSWORD = `Verify-Nudges-${crypto.randomUUID()}!`;
// Short enough that this script never needs to actually sleep to observe cooldown expiry (case
// 5 rewrites sent_at directly instead), long enough that case 4's immediate second send is
// unambiguously still inside the window even accounting for real network latency.
//
// Fix round 1: originally 2s, which a code review correctly flagged as too thin a margin - case
// 4 runs after ~7 sequential network round trips of setup/assertion following case 1's insert
// (toggle flips + restores + case 4's own send), and against a real hosted Supabase instance
// with ~100-400ms round-trip latency, cumulative elapsed time could approach or exceed a 2s
// window before case 4 even executes, causing an intermittent false pass unrelated to whether
// the underlying SQL is correct. Widened to 20s - comfortably larger than any plausible
// cumulative round-trip latency for 7 calls - and case 4 now logs the actual elapsed wall-clock
// time since case 1's insert so a future flake is diagnosable instead of silently misleading.
const COOLDOWN_SECONDS = 20;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function createTestUser(label) {
  const email = `nudges-test-${label}-${RUN_ID}@example.com`;
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

// Fix round 1: direct admin group setup, mirrored exactly from scripts/verify-digest.mjs's/
// scripts/verify-unlock-requests.mjs's createGroupWithMembers (same shortcut/rationale - the
// invite-code join flow itself is already proven by verify-rls.mjs). `memberIds` is every member
// INCLUDING the owner - see those scripts' comments on why omitting the owner from
// group_memberships breaks the group-visibility check.
async function createGroupWithMembers(ownerId, memberIds, name) {
  const groupId = crypto.randomUUID();
  const { error: groupErr } = await admin
    .from("friend_groups")
    .insert({ id: groupId, name, owner_user_id: ownerId });
  if (groupErr) throw new Error(`Failed to create group ${name}: ${groupErr.message}`);
  for (const userId of memberIds) {
    const { error: memErr } = await admin
      .from("group_memberships")
      .insert({ group_id: groupId, user_id: userId });
    if (memErr) throw new Error(`Failed to add ${userId} to group ${name}: ${memErr.message}`);
  }
  return groupId;
}

// Mirrors nudgeApi.ts's sendNudge() insert exactly (same table/columns) - the thing under test
// is whether the *database* (RLS + can_send_nudge()) gates this the way the real client code
// would, not whether this script re-derives its own logic.
async function sendNudgeAs(client, senderUserId, recipientUserId, messageId) {
  return client
    .from("nudges")
    .insert({ sender_user_id: senderUserId, recipient_user_id: recipientUserId, message_id: messageId })
    .select()
    .single();
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as verify-rls.mjs /
  // verify-friend-sync.mjs), so referencing rows must go before the rows/users they reference.
  await admin.from("nudges").delete().in("sender_user_id", userIds);
  await admin.from("nudges").delete().in("recipient_user_id", userIds);
  await admin.from("friendship_settings").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("friend_user_id", userIds);
  // Fix round 1: the new group_memberships/friend_groups rows created for S/R's shared-group
  // setup also need cleaning up - S is used as the owner (see main()), so filtering
  // group_memberships by user_id and friend_groups by owner_user_id (both already scoped to
  // userIds) covers everything this script now creates.
  await admin.from("group_memberships").delete().in("user_id", userIds);
  await admin.from("friend_groups").delete().in("owner_user_id", userIds);

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`  Failed to delete test user ${id}: ${error.message}`);
  }
  console.log("Cleanup done.");
}

async function main() {
  console.log("Creating ephemeral test accounts (S = sender, R = recipient, C = stranger)...");
  const userS = await createTestUser("s");
  const userR = await createTestUser("r");
  const userC = await createTestUser("c");
  const userIds = [userS.id, userR.id, userC.id];

  try {
    const clientS = await signInAs(userS.email);
    await signInAs(userR.email); // Not used to send/receive directly, but confirms R can sign in.
    await signInAs(userC.email); // Not used beyond the negative case below.
    record("Setup: S, R, and C signed in via anon-key client", true);

    // Fix round 1 (v2 Task 10 fix round 1, supabase/migrations/
    // 20260815000013_v2_tighten_friendship_settings_insert.sql): S and C share no group at all -
    // S's own INSERT toward C must now be denied outright, proving the tightened
    // friendship_settings INSERT policy's group-membership floor holds. Run BEFORE any group
    // exists for S, so this is unambiguously "no shared group anywhere", not just "no shared
    // group with THIS specific friend".
    const { data: deniedInsert, error: deniedInsertErr } = await clientS
      .from("friendship_settings")
      .insert({ user_id: userS.id, friend_user_id: userC.id, send_live_nudges: true });
    record(
      "Fix round 1: S cannot INSERT a friendship_settings row toward C (no shared group)",
      !!deniedInsertErr && !deniedInsert,
      deniedInsertErr ? undefined : "insert unexpectedly succeeded"
    );

    // Fix round 1: S and R must share a group before any further friendship_settings write below
    // - migration 20260815000012's trigger auto-creates both directions of the (S, R) row the
    // instant they do, and migration 20260815000013's tightened INSERT policy means a plain
    // `.insert()` toward a non-group-mate (like the negative case just above) is now denied
    // outright rather than merely colliding with the trigger's row.
    const sharedGroupId = await createGroupWithMembers(
      userS.id,
      [userS.id, userR.id],
      `Verify Nudges G1 ${RUN_ID}`
    );
    record("Setup: S and R share a group (C does not)", true);

    // S declares "I may nudge R" - written as S's own authenticated write (friendship_settings'
    // policies require user_id = auth.uid() for every operation). `.upsert()` (fix round 1, not
    // `.insert()`): the trigger above already auto-created this exact (S, R) row the moment R
    // joined the group (send_live_nudges defaults false since migration
    // 20260815000027_v2_default_legacy_visibility_to_false.sql - a v2 follow-up, this script's own
    // explicit `send_live_nudges: true` below is what actually grants the toggle now, not the
    // column default), so a plain `.insert()` here would still fail with a duplicate-key error
    // regardless of the default.
    const { error: sSettingsErr } = await clientS
      .from("friendship_settings")
      .upsert(
        { user_id: userS.id, friend_user_id: userR.id, send_live_nudges: true },
        { onConflict: "user_id,friend_user_id" }
      );
    record("Setup: S enables send_live_nudges toward R", !sSettingsErr, sSettingsErr?.message);

    // R declares "S may nudge me, with a short cooldown" - as an admin write here rather than
    // R's own client, purely so this script doesn't need to keep a second signed-in client
    // around; friendship_settings' RLS is not the thing under test on R's side (can_send_nudge()
    // reads this row via SECURITY DEFINER regardless of who wrote it). `.upsert()` for the same
    // trigger-already-created-this-row reason as S's write above (the service-role client
    // bypasses RLS entirely, but NOT the underlying primary-key uniqueness constraint, so a plain
    // `.insert()` would still fail with a duplicate-key error regardless of role).
    const { error: rSettingsErr } = await admin.from("friendship_settings").upsert(
      {
        user_id: userR.id,
        friend_user_id: userS.id,
        receive_live_nudges: true,
        nudge_cooldown_seconds: COOLDOWN_SECONDS,
      },
      { onConflict: "user_id,friend_user_id" }
    );
    record(
      "Setup: R enables receive_live_nudges toward S with a short cooldown",
      !rSettingsErr,
      rSettingsErr?.message
    );

    // --- Case 1: both toggles on, no prior nudge -> succeeds ---
    const { data: firstNudge, error: firstErr } = await sendNudgeAs(
      clientS,
      userS.id,
      userR.id,
      "keep-going"
    );
    // Fix round 1: wall-clock reference point for case 4's elapsed-time diagnostic below - see
    // COOLDOWN_SECONDS's comment for why this matters.
    const case1SentAtMs = Date.now();
    record(
      "Case 1: nudge succeeds when both toggles are on and no recent nudge exists",
      !firstErr && !!firstNudge,
      firstErr?.message
    );

    // --- Case 2: recipient's receive_live_nudges off -> rejected ---
    const { error: disableReceiveErr } = await admin
      .from("friendship_settings")
      .update({ receive_live_nudges: false })
      .eq("user_id", userR.id)
      .eq("friend_user_id", userS.id);
    record(
      "Setup: R disables receive_live_nudges toward S",
      !disableReceiveErr,
      disableReceiveErr?.message
    );

    const { data: blockedByReceiveToggle, error: receiveToggleErr } = await sendNudgeAs(
      clientS,
      userS.id,
      userR.id,
      "you-got-this"
    );
    record(
      "Case 2: nudge is rejected when recipient's receive_live_nudges is off",
      !!receiveToggleErr && !blockedByReceiveToggle,
      receiveToggleErr ? undefined : "insert unexpectedly succeeded"
    );

    // Restore receive_live_nudges so case 3 isolates the SENDER's toggle specifically.
    await admin
      .from("friendship_settings")
      .update({ receive_live_nudges: true })
      .eq("user_id", userR.id)
      .eq("friend_user_id", userS.id);

    // --- Case 3: sender's send_live_nudges off -> rejected ---
    const { error: disableSendErr } = await clientS
      .from("friendship_settings")
      .update({ send_live_nudges: false })
      .eq("user_id", userS.id)
      .eq("friend_user_id", userR.id);
    record("Setup: S disables send_live_nudges toward R", !disableSendErr, disableSendErr?.message);

    const { data: blockedBySendToggle, error: sendToggleErr } = await sendNudgeAs(
      clientS,
      userS.id,
      userR.id,
      "proud-of-you"
    );
    record(
      "Case 3: nudge is rejected when sender's send_live_nudges is off",
      !!sendToggleErr && !blockedBySendToggle,
      sendToggleErr ? undefined : "insert unexpectedly succeeded"
    );

    // Restore send_live_nudges for the remaining cooldown cases.
    await clientS
      .from("friendship_settings")
      .update({ send_live_nudges: true })
      .eq("user_id", userS.id)
      .eq("friend_user_id", userR.id);

    // --- Case 4: second nudge within the cooldown window -> rejected ---
    // firstNudge (case 1) is still the most recent nudge from S to R - this send should be
    // rejected purely on cooldown grounds, both toggles being on. Fix round 1: log the actual
    // elapsed wall-clock time since case 1's insert (not just assume it's "moments ago") so a
    // future flake here - the window elapsing before this assertion runs, due to real network
    // latency across the ~7 round trips since case 1 - is diagnosable rather than silently
    // misleading. Warn loudly (without failing the run) if the margin looks thin, since that's a
    // sign COOLDOWN_SECONDS may need widening further on whatever environment this ran in.
    const elapsedSinceCase1Ms = Date.now() - case1SentAtMs;
    const marginRatio = elapsedSinceCase1Ms / (COOLDOWN_SECONDS * 1000);
    console.log(
      `  (elapsed since case 1's nudge: ${elapsedSinceCase1Ms}ms of a ${COOLDOWN_SECONDS * 1000}ms cooldown window - ${(marginRatio * 100).toFixed(1)}% consumed)`
    );
    if (marginRatio > 0.5) {
      console.warn(
        `  WARNING: case 4 consumed over half the cooldown window before its assertion ran - COOLDOWN_SECONDS may need widening further on this environment.`
      );
    }

    const { data: blockedByCooldown, error: cooldownErr } = await sendNudgeAs(
      clientS,
      userS.id,
      userR.id,
      "small-steps"
    );
    record(
      "Case 4: a second nudge within the cooldown window is rejected",
      !!cooldownErr && !blockedByCooldown,
      cooldownErr ? undefined : "insert unexpectedly succeeded"
    );

    // --- Case 5: cooldown elapsed -> succeeds ---
    // Rather than sleeping COOLDOWN_SECONDS in this script, simulate elapsed time by rewriting
    // the existing nudge's sent_at into the past via the service-role client (bypasses RLS,
    // exactly as this task's instructions describe as the preferred approach).
    if (firstNudge) {
      const pastTimestamp = new Date(Date.now() - (COOLDOWN_SECONDS + 1) * 1000).toISOString();
      const { error: rewriteErr } = await admin
        .from("nudges")
        .update({ sent_at: pastTimestamp })
        .eq("id", firstNudge.id);
      record(
        "Setup: backdate the prior nudge's sent_at past the cooldown window",
        !rewriteErr,
        rewriteErr?.message
      );
    }

    const { data: afterCooldown, error: afterCooldownErr } = await sendNudgeAs(
      clientS,
      userS.id,
      userR.id,
      "almost-there"
    );
    record(
      "Case 5: a nudge after the cooldown has elapsed succeeds",
      !afterCooldownErr && !!afterCooldown,
      afterCooldownErr?.message
    );

    // --- Case 6 (Important #1 fix round): sender leaves the shared group entirely, both toggles
    // left untouched (still on) -> rejected ---
    // This is the exact live-confirmed scenario from code review: A and B share a group, both
    // opt in, A leaves the group entirely, and A could still successfully nudge B forever -
    // can_send_nudge() (supabase/migrations/20260815000007_v2_nudges.sql) never checked
    // users_share_a_group() or any live group_memberships row, only the two friendship_settings
    // toggles and the cooldown, which are never pruned on leave. Fixed by supabase/migrations/
    // 20260815000029_v2_nudges_require_shared_group.sql - this case is its negative-case proof,
    // specifically covering "used to share a group, then left" (not "never shared one at all",
    // which case 2/3 already touch indirectly by construction - this is the sharper, exact-match
    // regression case).
    //
    // Backdate case 5's nudge too (same technique as case 5's own setup), so this case isolates
    // the group-membership floor specifically - without this, a rejection here would be
    // ambiguous (could be the cooldown carried over from case 5's own nudge just above, not the
    // missing shared group).
    if (afterCooldown) {
      const pastTimestamp2 = new Date(Date.now() - (COOLDOWN_SECONDS + 1) * 1000).toISOString();
      const { error: rewriteErr2 } = await admin
        .from("nudges")
        .update({ sent_at: pastTimestamp2 })
        .eq("id", afterCooldown.id);
      record(
        "Setup: backdate case 5's nudge too, so case 6 isolates the group-membership check",
        !rewriteErr2,
        rewriteErr2?.message
      );
    }

    const { error: leaveErr } = await admin
      .from("group_memberships")
      .delete()
      .eq("group_id", sharedGroupId)
      .eq("user_id", userS.id);
    record("Setup: S leaves the shared group with R (toggles left untouched)", !leaveErr, leaveErr?.message);

    const { data: sharedAfterLeave, error: shareCheckErr } = await admin.rpc("users_share_a_group", {
      p_user_a: userS.id,
      p_user_b: userR.id,
    });
    const shareCheckPassed = !shareCheckErr && sharedAfterLeave === false;
    record(
      "Setup: users_share_a_group(S, R) is now false after S leaves",
      shareCheckPassed,
      shareCheckPassed ? undefined : (shareCheckErr?.message ?? `expected false, got ${sharedAfterLeave}`)
    );

    const { data: blockedByNoSharedGroup, error: noSharedGroupErr } = await sendNudgeAs(
      clientS,
      userS.id,
      userR.id,
      "still-here"
    );
    record(
      "Case 6: nudge is rejected once sender and recipient no longer share any group, even with both toggles still on",
      !!noSharedGroupErr && !blockedByNoSharedGroup,
      noSharedGroupErr ? undefined : "insert unexpectedly succeeded"
    );
  } finally {
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Nudges verification summary ===");
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
  console.error("verify-nudges.mjs crashed:", err);
  process.exit(1);
});
