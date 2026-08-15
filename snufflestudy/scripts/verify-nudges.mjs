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
//   1. Creates two ephemeral, auto-confirmed accounts S (sender) and R (recipient) via the
//      service-role admin API, signs in as each via the anon-key client (password auth), so
//      every write below goes through the same RLS-bound client nudgeApi.ts's sendNudge() would
//      use.
//   2. Case 1 (positive): S enables send_live_nudges toward R, R enables receive_live_nudges
//      toward S with a shortened cooldown (COOLDOWN_SECONDS below, so this script never needs to
//      sleep for the real default of 300s) - a nudge from S to R succeeds.
//   3. Case 2: R turns receive_live_nudges off - the next nudge from S to R is rejected.
//   4. Case 3: R turns receive_live_nudges back on, S turns send_live_nudges off - the next
//      nudge from S to R is rejected.
//   5. Case 4: S turns send_live_nudges back on - a second nudge sent immediately (within the
//      cooldown window) is rejected. Fix round 1: this case runs after ~7 sequential network
//      round trips of setup/assertion following case 1's nudge insert, so COOLDOWN_SECONDS must
//      stay comfortably larger than that cumulative round-trip latency against a real hosted
//      Supabase instance, or this case can intermittently false-pass (the window elapses before
//      the assertion runs, so the second send wrongly succeeds instead of being rejected) for
//      reasons that have nothing to do with whether the underlying SQL is actually correct. The
//      elapsed wall-clock time since case 1's insert is logged right before this case's
//      assertion specifically so a future flake here is diagnosable rather than silently
//      misleading.
//   6. Case 5: the service-role client rewrites that nudge's sent_at to (COOLDOWN_SECONDS + 1)s
//      in the past (simulated elapsed time, per this task's instruction to avoid actually
//      sleeping in the script) - a subsequent nudge from S to R now succeeds.
//   7. Cleans up every row it created and both test accounts via the service-role client.
//   8. Prints a pass/fail summary and exits non-zero if anything failed.

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

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`  Failed to delete test user ${id}: ${error.message}`);
  }
  console.log("Cleanup done.");
}

async function main() {
  console.log("Creating ephemeral test accounts (S = sender, R = recipient)...");
  const userS = await createTestUser("s");
  const userR = await createTestUser("r");
  const userIds = [userS.id, userR.id];

  try {
    const clientS = await signInAs(userS.email);
    await signInAs(userR.email); // Not used to send/receive directly, but confirms R can sign in.
    record("Setup: S and R signed in via anon-key client", true);

    // S declares "I may nudge R" - written as S's own authenticated insert (friendship_settings'
    // "users manage only their own settings rows" RLS policy requires user_id = auth.uid()).
    const { error: sSettingsErr } = await clientS
      .from("friendship_settings")
      .insert({ user_id: userS.id, friend_user_id: userR.id, send_live_nudges: true });
    record("Setup: S enables send_live_nudges toward R", !sSettingsErr, sSettingsErr?.message);

    // R declares "S may nudge me, with a short cooldown" - as an admin insert here rather than
    // R's own client, purely so this script doesn't need to keep a second signed-in client
    // around; friendship_settings' RLS is not the thing under test on R's side (can_send_nudge()
    // reads this row via SECURITY DEFINER regardless of who wrote it).
    const { error: rSettingsErr } = await admin.from("friendship_settings").insert({
      user_id: userR.id,
      friend_user_id: userS.id,
      receive_live_nudges: true,
      nudge_cooldown_seconds: COOLDOWN_SECONDS,
    });
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
