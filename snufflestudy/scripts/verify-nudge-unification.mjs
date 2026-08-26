// Live end-to-end proof for v3.4 Task 8's Definition of Done: nudges and Producer Tags unified
// into "nudge: written, audio" with INDEPENDENT per-type cooldowns, and rate-limit enforcement
// extended to producer_tag_sends for the first time (today/pre-this-task it has none at all).
//
// Standalone Node script (same style/conventions as scripts/verify-nudges.mjs and
// scripts/verify-friendships.mjs) - reads .env via dotenv/config, not part of `npm test`.
// Run directly: node scripts/verify-nudge-unification.mjs
//
// Accounts: A (sender), B (recipient/friend). A direct `friendships` row is inserted via the
// service-role client (bypasses RLS, but NOT the friendships_create_friendship_settings trigger -
// triggers fire regardless of which role performed the write), which is how a friends-model pair
// gets created now that group_memberships/friend_groups are dropped (v3.4 Task 2).
//
// What it does (case numbers referenced in the report):
//   0. Static proof the rate-limit gate is NEW, not pre-existing: reads
//      supabase/migrations/20260815000040_v3.4_friendships.sql (the immediately-prior version of
//      the producer_tag_sends INSERT policy, live right before this task's migration) and confirms
//      it references no cooldown-gate function at all (only are_friends()) - then confirms this
//      task's own migration file DOES define/reference can_send_producer_tag_dm(). This is the
//      "today's producer_tag_sends INSERT policy had zero rate-limit enforcement prior to this
//      task" comparison the task's own instructions ask to document.
//   1. friendship_settings defaults: inserting the (A, B) friendships row auto-creates both
//      directions' friendship_settings rows (existing trigger, retargeted by Task 2) with the new
//      split columns nudge_cooldown_seconds_written = nudge_cooldown_seconds_audio = 60 (the
//      literal ADD COLUMN ... DEFAULT backfill this task's migration relies on - re-confirmed
//      directly against Postgres's own column-default metadata and a table-wide null-count check,
//      not just these two freshly-created rows). Also confirms the OLD nudge_cooldown_seconds
//      column is genuinely gone (a bare .select("nudge_cooldown_seconds") errors).
//   2. Case A: A sends B a WRITTEN nudge - succeeds (both toggles on, no prior nudge).
//   3. Case B: A immediately sends another WRITTEN nudge - fails (written cooldown active).
//   4. Case C (the core new behavior this task adds): A immediately sends B an AUDIO nudge -
//      succeeds, DESPITE the written cooldown from case B still being active. Under the old
//      single shared nudge_cooldown_seconds column this would have been blocked; this proves the
//      two cooldowns are now genuinely independent.
//   5. Case D: A immediately sends a second AUDIO nudge - fails (its own, separate cooldown).
//   6. Elapsed-time proof: backdates every existing (A -> B) nudges/producer_tag_sends row's
//      sent_at to 61s in the past (service-role write, simulating "waited 60+ seconds" rather than
//      actually sleeping - explicitly sanctioned by this task's own instructions), then confirms
//      BOTH a written and an audio retry now succeed.
//   7. Negative-case-in-reverse (the one specific regression-in-reverse this task must produce
//      evidence of): backdates again, then fires 5 audio sends to B in rapid succession (no delay
//      between them) and counts successes - expects exactly 1 (the first; the other 4 hit the
//      brand-new cooldown gate that did not exist before this task).
//   8. Shared-toggle proof, both directions: backdates once more (so cooldown isn't a confound),
//      then B turns receive_live_nudges OFF toward A - confirms BOTH a written AND an audio send
//      from A are now rejected (one toggle gates both types, per the scope doc's "one on/off
//      toggle, two cooldowns" design).
//   9. Cleans up every row and test account it created.
//  10. Prints a pass/fail summary and exits non-zero if anything failed.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");

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
const PASSWORD = `Verify-NudgeUnification-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function createTestUser(label) {
  const email = `nudge-unification-test-${label}-${RUN_ID}@example.com`;
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

// Mirrors nudgeApi.ts's sendNudge() insert exactly (same table/columns).
async function sendNudgeAs(client, senderUserId, recipientUserId, messageId) {
  return client
    .from("nudges")
    .insert({ sender_user_id: senderUserId, recipient_user_id: recipientUserId, message_id: messageId })
    .select()
    .single();
}

// Mirrors producerTagApi.ts's sendToFriend() insert exactly (same table/columns).
async function sendAudioAs(client, senderUserId, recipientUserId, tagId) {
  return client
    .from("producer_tag_sends")
    .insert({ tag_id: tagId, sender_user_id: senderUserId, recipient_user_id: recipientUserId })
    .select()
    .single();
}

async function createProducerTagAs(client, userId) {
  return client
    .from("producer_tags")
    .insert({
      user_id: userId,
      audio_url: `verify/${RUN_ID}/${crypto.randomUUID()}.webm`,
      duration_ms: 3000,
    })
    .select()
    .single();
}

// Simulates "60+ seconds elapsed" by backdating EVERY existing row for this (sender, recipient)
// pair - not just the most recent - since can_send_nudge()/can_send_producer_tag_dm() both key
// off max(sent_at) across ALL matching rows, not just the latest insert.
async function backdateAllPast(table, senderUserId, recipientUserId, secondsAgo) {
  const past = new Date(Date.now() - secondsAgo * 1000).toISOString();
  const { error } = await admin
    .from(table)
    .update({ sent_at: past })
    .eq("sender_user_id", senderUserId)
    .eq("recipient_user_id", recipientUserId);
  return error;
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

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error && !error.message?.includes("User not found")) {
      console.error(`  Failed to delete test user ${id}: ${error.message}`);
    }
  }
  console.log("Cleanup done.");
}

async function main() {
  // --- Case 0: static proof the gate is NEW, not pre-existing ---
  const priorMigration = await readFile(
    path.join(migrationsDir, "20260815000040_v3.4_friendships.sql"),
    "utf8"
  );
  const thisMigration = await readFile(
    path.join(migrationsDir, "20260815000044_v3.4_nudge_cooldowns_and_producer_tag_rate_limit.sql"),
    "utf8"
  );
  record(
    "Case 0a: the immediately-prior producer_tag_sends INSERT policy (20260815000040, live right before this task) references no cooldown-gate function at all",
    !priorMigration.includes("can_send_producer_tag_dm"),
    priorMigration.includes("can_send_producer_tag_dm") ? "found a reference unexpectedly" : undefined
  );
  record(
    "Case 0b: this task's migration (20260815000044) defines can_send_producer_tag_dm() and routes the DM branch through it",
    thisMigration.includes("create or replace function public.can_send_producer_tag_dm") &&
      thisMigration.includes("can_send_producer_tag_dm(sender_user_id, recipient_user_id)"),
    undefined
  );

  console.log("\nCreating ephemeral test accounts (A = sender, B = recipient)...");
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userIds = [userA.id, userB.id];

  try {
    const clientA = await signInAs(userA.email);
    const clientB = await signInAs(userB.email);
    record("Setup: A and B signed in via anon-key client", true);

    // --- Setup: A and B become friends directly (service-role write; group model is gone) ---
    const aId = userA.id < userB.id ? userA.id : userB.id;
    const bId = userA.id < userB.id ? userB.id : userA.id;
    const { error: friendshipErr } = await admin
      .from("friendships")
      .insert({ user_id_a: aId, user_id_b: bId, initiated_by: userA.id });
    record("Setup: A and B become friends (friendships row inserted)", !friendshipErr, friendshipErr?.message);

    // --- Case 1: friendship_settings defaults, both directions ---
    const { data: settingsAtoB, error: settingsAtoBErr } = await admin
      .from("friendship_settings")
      .select()
      .eq("user_id", userA.id)
      .eq("friend_user_id", userB.id)
      .single();
    const { data: settingsBtoA, error: settingsBtoAErr } = await admin
      .from("friendship_settings")
      .select()
      .eq("user_id", userB.id)
      .eq("friend_user_id", userA.id)
      .single();
    const defaultsMatch = (row) =>
      !!row && row.nudge_cooldown_seconds_written === 60 && row.nudge_cooldown_seconds_audio === 60;
    record(
      "Case 1a: friendship_settings(A -> B) auto-created with nudge_cooldown_seconds_written = nudge_cooldown_seconds_audio = 60",
      !settingsAtoBErr && defaultsMatch(settingsAtoB),
      settingsAtoBErr?.message ?? JSON.stringify(settingsAtoB)
    );
    record(
      "Case 1b: friendship_settings(B -> A) auto-created with the same defaults",
      !settingsBtoAErr && defaultsMatch(settingsBtoA),
      settingsBtoAErr?.message ?? JSON.stringify(settingsBtoA)
    );

    const { error: oldColumnErr } = await admin
      .from("friendship_settings")
      .select("nudge_cooldown_seconds")
      .limit(1);
    record(
      "Case 1c: the old single nudge_cooldown_seconds column is genuinely dropped (a select on it errors)",
      !!oldColumnErr,
      oldColumnErr ? undefined : "select unexpectedly succeeded - column still exists"
    );

    // Table-wide null check: proves the ADD COLUMN ... DEFAULT backfill actually took effect for
    // every row in the table (not just the two just created above), matching the DoD's "a real
    // behavior change for existing friend pairs, not just new ones" requirement.
    const { count: nullCount, error: nullCountErr } = await admin
      .from("friendship_settings")
      .select("user_id", { count: "exact", head: true })
      .or("nudge_cooldown_seconds_written.is.null,nudge_cooldown_seconds_audio.is.null");
    record(
      "Case 1d: zero friendship_settings rows table-wide have a null cooldown column (ADD COLUMN...DEFAULT backfilled every existing row)",
      !nullCountErr && nullCount === 0,
      nullCountErr?.message ?? `${nullCount} row(s) with a null cooldown column`
    );

    // --- Enable both toggles: A may send to B, B may receive from A ---
    const { error: sendToggleErr } = await admin
      .from("friendship_settings")
      .update({ send_live_nudges: true })
      .eq("user_id", userA.id)
      .eq("friend_user_id", userB.id);
    const { error: receiveToggleErr } = await admin
      .from("friendship_settings")
      .update({ receive_live_nudges: true })
      .eq("user_id", userB.id)
      .eq("friend_user_id", userA.id);
    record(
      "Setup: A's send_live_nudges and B's receive_live_nudges both enabled",
      !sendToggleErr && !receiveToggleErr,
      [sendToggleErr, receiveToggleErr].filter(Boolean).map((e) => e.message).join("; ") || undefined
    );

    // --- Case A: written nudge #1 succeeds ---
    const { data: writtenFirst, error: writtenFirstErr } = await sendNudgeAs(
      clientA,
      userA.id,
      userB.id,
      "keep-going"
    );
    record(
      "Case A: A sends B a WRITTEN nudge - succeeds",
      !writtenFirstErr && !!writtenFirst,
      writtenFirstErr?.message
    );

    // --- Case B: written nudge #2 immediately - fails (written cooldown) ---
    const { data: writtenSecond, error: writtenSecondErr } = await sendNudgeAs(
      clientA,
      userA.id,
      userB.id,
      "you-got-this"
    );
    record(
      "Case B: A immediately sends another WRITTEN nudge - fails (written cooldown active)",
      !!writtenSecondErr && !writtenSecond,
      writtenSecondErr ? undefined : "insert unexpectedly SUCCEEDED"
    );

    // --- Case C: audio nudge #1 immediately - succeeds (THE core independent-cooldown proof) ---
    const { data: tag1, error: tag1Err } = await createProducerTagAs(clientA, userA.id);
    record("Setup: A records/uploads a producer_tags row (tag1)", !tag1Err && !!tag1, tag1Err?.message);

    const { data: audioFirst, error: audioFirstErr } = tag1
      ? await sendAudioAs(clientA, userA.id, userB.id, tag1.id)
      : { data: null, error: new Error("no tag1") };
    record(
      "Case C (core new behavior): A immediately sends B an AUDIO nudge - succeeds despite the WRITTEN cooldown still being active (independent cooldowns)",
      !audioFirstErr && !!audioFirst,
      audioFirstErr?.message
    );

    // --- Case D: audio nudge #2 immediately - fails (own, separate cooldown) ---
    const { data: tag2, error: tag2Err } = await createProducerTagAs(clientA, userA.id);
    record("Setup: A records/uploads a second producer_tags row (tag2)", !tag2Err && !!tag2, tag2Err?.message);

    const { data: audioSecond, error: audioSecondErr } = tag2
      ? await sendAudioAs(clientA, userA.id, userB.id, tag2.id)
      : { data: null, error: new Error("no tag2") };
    record(
      "Case D: A immediately sends a second AUDIO nudge - fails (its own, separate cooldown)",
      !!audioSecondErr && !audioSecond,
      audioSecondErr ? undefined : "insert unexpectedly SUCCEEDED"
    );

    // --- Elapsed-time proof: backdate, then confirm BOTH types succeed again ---
    const backdateErr1 = await backdateAllPast("nudges", userA.id, userB.id, 61);
    const backdateErr2 = await backdateAllPast("producer_tag_sends", userA.id, userB.id, 61);
    record(
      "Setup: backdate every existing (A -> B) nudges/producer_tag_sends row's sent_at 61s into the past",
      !backdateErr1 && !backdateErr2,
      [backdateErr1, backdateErr2].filter(Boolean).map((e) => e.message).join("; ") || undefined
    );

    const { data: writtenAfterWait, error: writtenAfterWaitErr } = await sendNudgeAs(
      clientA,
      userA.id,
      userB.id,
      "proud-of-you"
    );
    record(
      "Elapsed-time proof: a WRITTEN retry succeeds once 60+s have (simulated) elapsed",
      !writtenAfterWaitErr && !!writtenAfterWait,
      writtenAfterWaitErr?.message
    );

    const { data: tag3, error: tag3Err } = await createProducerTagAs(clientA, userA.id);
    const { data: audioAfterWait, error: audioAfterWaitErr } = tag3
      ? await sendAudioAs(clientA, userA.id, userB.id, tag3.id)
      : { data: null, error: tag3Err ?? new Error("no tag3") };
    record(
      "Elapsed-time proof: an AUDIO retry succeeds once 60+s have (simulated) elapsed",
      !audioAfterWaitErr && !!audioAfterWait,
      audioAfterWaitErr?.message
    );

    // --- Case: 5 rapid audio sends, only the first succeeds (negative-case-in-reverse) ---
    const backdateErr3 = await backdateAllPast("producer_tag_sends", userA.id, userB.id, 61);
    record(
      "Setup: backdate producer_tag_sends once more before the 5-rapid-sends test",
      !backdateErr3,
      backdateErr3?.message
    );

    const rapidResults = [];
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential/rapid, not
      // concurrent, so each insert observes the previous one's committed sent_at (same as a real
      // user rapid-clicking "Send").
      const { data: tag, error: tagErr } = await createProducerTagAs(clientA, userA.id);
      if (tagErr || !tag) {
        rapidResults.push({ ok: false, error: tagErr });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await sendAudioAs(clientA, userA.id, userB.id, tag.id);
      rapidResults.push({ ok: !error && !!data, error });
    }
    const successCount = rapidResults.filter((r) => r.ok).length;
    record(
      "5 rapid audio sends to the same friend: exactly 1 succeeds (the first), the other 4 hit the new cooldown gate",
      successCount === 1,
      `${successCount} of 5 succeeded (expected 1) - per-attempt results: ${rapidResults
        .map((r, i) => `#${i + 1}=${r.ok ? "OK" : "blocked"}`)
        .join(", ")}`
    );

    // --- Shared-toggle proof, both directions ---
    const backdateErr4 = await backdateAllPast("nudges", userA.id, userB.id, 61);
    const backdateErr5 = await backdateAllPast("producer_tag_sends", userA.id, userB.id, 61);
    record(
      "Setup: backdate both tables once more so cooldown isn't a confound for the toggle test",
      !backdateErr4 && !backdateErr5,
      [backdateErr4, backdateErr5].filter(Boolean).map((e) => e.message).join("; ") || undefined
    );

    const { error: toggleOffErr } = await admin
      .from("friendship_settings")
      .update({ receive_live_nudges: false })
      .eq("user_id", userB.id)
      .eq("friend_user_id", userA.id);
    record("Setup: B turns receive_live_nudges OFF toward A", !toggleOffErr, toggleOffErr?.message);

    const { data: writtenBlockedByToggle, error: writtenBlockedByToggleErr } = await sendNudgeAs(
      clientA,
      userA.id,
      userB.id,
      "small-steps"
    );
    record(
      "Shared toggle (written direction): B's receive_live_nudges off blocks a WRITTEN nudge from A",
      !!writtenBlockedByToggleErr && !writtenBlockedByToggle,
      writtenBlockedByToggleErr ? undefined : "insert unexpectedly SUCCEEDED"
    );

    const { data: tag4, error: tag4Err } = await createProducerTagAs(clientA, userA.id);
    const { data: audioBlockedByToggle, error: audioBlockedByToggleErr } = tag4
      ? await sendAudioAs(clientA, userA.id, userB.id, tag4.id)
      : { data: null, error: tag4Err ?? new Error("no tag4") };
    record(
      "Shared toggle (audio direction): B's receive_live_nudges off ALSO blocks an AUDIO nudge from A (same toggle gates both types)",
      !!audioBlockedByToggleErr && !audioBlockedByToggle,
      audioBlockedByToggleErr ? undefined : "insert unexpectedly SUCCEEDED"
    );
  } finally {
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Nudge unification verification summary ===");
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
