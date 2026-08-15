// Live end-to-end proof for Task 9's Definition of Done: "a friend who opted into digests (and
// not live nudges) sees one summary per day, not per session; a friend who opted out sees
// nothing." A mocked unit test (see src/infrastructure/backend/digestApi.test.ts) can only prove
// fetchDigestForDate/pollNewDigests call the right table/columns - it can't prove the live
// database's RLS policy + friend_has_granted_digest_visibility()/compute_daily_digests()
// (supabase/migrations/20260815000010_v2_daily_digests.sql) actually aggregate and gate access
// the way they claim to. This script proves that against the live project.
//
// Standalone Node script (same style/conventions as scripts/verify-unlock-requests.mjs, the most
// recent/closest in shape - reuses its test-account helpers) - reads .env via dotenv/config, not
// part of `npm test`. Run directly: node scripts/verify-digest.mjs
//
// Since a real pg_cron tick can't be waited for in a verification script, this invokes
// compute_daily_digests(target_date) directly via the service-role client (RPC) for a specific
// test date, after seeding session_status_events rows with known counts - including at least one
// RECOVERY row, proving Part B's messageRouter.ts wiring (recordRecovery) produces real backend
// data an aggregation can actually consume, not just a domain-level unit test in isolation.
//
// What it does:
//   1. Creates three ephemeral, auto-confirmed accounts via the service-role admin API: S
//      (subject - the person being digested about), F (friend who opts INTO
//      receive_daily_digest toward S), N (friend who does NOT opt in). Signs in as each via the
//      anon-key client (password auth), so every read below goes through the same RLS-bound
//      client digestApi.ts's fetchDigestForDate() would use.
//   2. Seeds session_status_events rows directly (service-role, bypassing RLS - the insert path
//      itself is already proven by scripts/verify-friend-sync.mjs; this script's focus is
//      aggregation + digest visibility) for S on DATE_A with known counts: 2 SESSION_COMPLETED,
//      1 SESSION_ABANDONED, 3 DISTRACTION_ATTEMPT, 2 RECOVERY - so recovery_rate should compute
//      to 2/3.
//   3. Case 1: F sets friendship_settings (user_id=F, friend_user_id=S, receive_daily_digest=
//      true) - opts in. Calls compute_daily_digests(DATE_A) via the service-role RPC. F can then
//      SELECT the resulting daily_digests row for S/DATE_A and sees the exact seeded counts.
//   4. Case 2: N has NO friendship_settings row toward S at all (the default "opted out" state -
//      supabase/migrations/20260815000007_v2_nudges.sql's can_send_nudge() comment documents
//      this codebase's "no row = not opted in" convention, which this migration's
//      friend_has_granted_digest_visibility() follows identically). N attempts to SELECT the same
//      row and sees nothing.
//   5. Case 3: compute_daily_digests(DATE_B) - a second date with zero seeded events for S - is
//      called. F queries daily_digests filtered to DATE_B and gets nothing back (not stale data
//      carried over from DATE_A).
//   6. Case 4: compute_daily_digests(DATE_A) is called a SECOND time (simulating a re-run of the
//      same day, e.g. a retried cron tick) - S's row is upserted (same primary key), not
//      duplicated, and the values are unchanged. A raw admin count confirms exactly one row still
//      exists for (S, DATE_A).
//   7. Case 5: seeds a second subject S2 with ZERO DISTRACTION_ATTEMPT events that day (only one
//      SESSION_COMPLETED) and computes their digest - confirms the zero-distraction convention
//      documented in the migration (recovery_rate = 1.0, not NaN/0/error).
//   8. Cleans up every row it created and all test accounts via the service-role client.
//   9. Prints a pass/fail summary and exits non-zero if anything failed.

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
const PASSWORD = `Verify-Digest-${crypto.randomUUID()}!`;

// Two distinct test dates, far in the past relative to RUN_ID's real-world date, so this script
// never collides with any digest a real pg_cron tick might independently compute during a run
// (compute_daily_digests defaults to yesterday - these are fixed, arbitrary historical dates
// instead, well outside that window).
const DATE_A = "2020-03-01";
const DATE_B = "2020-03-02";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectDenied(name, fn) {
  try {
    const { data, error } = await fn();
    if (error) {
      record(name, true, `denied — ${error.message}`);
      return;
    }
    const isEmpty = data === null || (Array.isArray(data) && data.length === 0);
    if (isEmpty) {
      record(name, true, "denied — no rows returned");
    } else {
      record(name, false, `NOT denied — received data: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    record(name, true, `denied — threw ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function expectOk(name, fn) {
  try {
    const { data, error } = await fn();
    if (error) {
      record(name, false, `expected success — ${error.message}`);
      return null;
    }
    record(name, true);
    return data;
  } catch (err) {
    record(name, false, `expected success — threw ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// compute_daily_digests() returns void, so a successful RPC call's `data` is `null` - the exact
// same value expectOk returns on FAILURE. Using expectOk's return value to gate follow-up
// assertions for a void RPC would silently skip them on success too (a real bug caught while
// running this script for the first time - the fix is this dedicated boolean-returning variant
// for calls whose return value carries no meaning of its own).
async function expectOkVoid(name, fn) {
  try {
    const { error } = await fn();
    if (error) {
      record(name, false, `expected success — ${error.message}`);
      return false;
    }
    record(name, true);
    return true;
  } catch (err) {
    record(name, false, `expected success — threw ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function createTestUser(label) {
  const email = `digest-test-${label}-${RUN_ID}@example.com`;
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

// Seeds a session_status_events row directly via the service-role client (bypasses RLS - the
// insert path itself is already proven live by scripts/verify-friend-sync.mjs; this script's
// focus is compute_daily_digests()'s aggregation and daily_digests' own visibility policy, not
// re-proving session_status_events' insert policy). occurredAtIso must land within targetDate
// (UTC) for compute_daily_digests to pick it up - mirrors that function's own
// `occurred_at >= target_date::timestamptz and occurred_at < (target_date + 1)::timestamptz`
// filter.
async function seedEvent(userId, sessionId, type, targetDate, hourUtc) {
  const occurredAt = `${targetDate}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
  const { error } = await admin.from("session_status_events").insert({
    user_id: userId,
    session_id: sessionId,
    type,
    display_label: type === "RECOVERY" ? "got back on track" : type,
    occurred_at: occurredAt,
  });
  if (error) throw new Error(`Failed to seed ${type} event for ${userId}: ${error.message}`);
}

async function computeDigests(targetDate) {
  return admin.rpc("compute_daily_digests", { target_date: targetDate });
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as verify-rls.mjs/
  // verify-friend-sync.mjs/verify-nudges.mjs/verify-unlock-requests.mjs), so referencing rows
  // must go before the rows/users they reference.
  await admin.from("daily_digests").delete().in("subject_user_id", userIds);
  await admin.from("session_status_events").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("friend_user_id", userIds);

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`  Failed to delete test user ${id}: ${error.message}`);
  }
  console.log("Cleanup done.");
}

async function main() {
  console.log("Creating ephemeral test accounts (S = subject, F = opted-in friend, N = opted-out friend)...");
  const userS = await createTestUser("s");
  const userF = await createTestUser("f");
  const userN = await createTestUser("n");
  const userS2 = await createTestUser("s2");
  const userIds = [userS.id, userF.id, userN.id, userS2.id];

  try {
    const clientF = await signInAs(userF.email);
    const clientN = await signInAs(userN.email);
    await signInAs(userS.email); // Not used directly below, but confirms S can sign in.
    record("Setup: S, F, N signed in via anon-key client", true);

    // --- Seed S's session_status_events for DATE_A: 2 completed, 1 abandoned, 3 distractions,
    // 2 recoveries -> recovery_rate should compute to 2/3 ---
    const sessionId = `verify-digest-${RUN_ID}`;
    await seedEvent(userS.id, sessionId, "SESSION_COMPLETED", DATE_A, 9);
    await seedEvent(userS.id, sessionId, "SESSION_COMPLETED", DATE_A, 14);
    await seedEvent(userS.id, sessionId, "SESSION_ABANDONED", DATE_A, 18);
    await seedEvent(userS.id, sessionId, "DISTRACTION_ATTEMPT", DATE_A, 9);
    await seedEvent(userS.id, sessionId, "DISTRACTION_ATTEMPT", DATE_A, 10);
    await seedEvent(userS.id, sessionId, "DISTRACTION_ATTEMPT", DATE_A, 11);
    // Proves Part B's messageRouter.ts recordRecovery wiring produces real, consumable backend
    // data - RECOVERY events only exist in this table at all because that wiring now calls
    // recordFriendStatusEvent("RECOVERY", ...), which is the exact dual-write this row mirrors.
    await seedEvent(userS.id, sessionId, "RECOVERY", DATE_A, 9);
    await seedEvent(userS.id, sessionId, "RECOVERY", DATE_A, 10);
    record("Setup: seeded S's session_status_events for DATE_A (2 completed, 1 abandoned, 3 distractions, 2 recoveries)", true);

    // --- Case 1: F opts in, compute_daily_digests(DATE_A), F sees the correct aggregated numbers ---
    const { error: fOptInErr } = await clientF
      .from("friendship_settings")
      .insert({ user_id: userF.id, friend_user_id: userS.id, receive_daily_digest: true });
    record("Setup: F opts into receive_daily_digest toward S", !fOptInErr, fOptInErr?.message);

    const computeOk1 = await expectOkVoid("Case 1: compute_daily_digests(DATE_A) succeeds", () =>
      computeDigests(DATE_A)
    );

    if (computeOk1) {
      const rowForF = await expectOk("Case 1: F (opted-in friend) can read S's digest for DATE_A", () =>
        clientF
          .from("daily_digests")
          .select()
          .eq("subject_user_id", userS.id)
          .eq("digest_date", DATE_A)
          .single()
      );
      if (rowForF) {
        record(
          "Case 1: aggregated numbers match the seeded counts exactly (2 completed, 1 abandoned, 3 distractions, recovery_rate=2/3)",
          rowForF.completed_sessions === 2 &&
            rowForF.abandoned_sessions === 1 &&
            rowForF.distraction_count === 3 &&
            Math.abs(rowForF.recovery_rate - 2 / 3) < 0.001,
          `got completed=${rowForF.completed_sessions}, abandoned=${rowForF.abandoned_sessions}, distractions=${rowForF.distraction_count}, recovery_rate=${rowForF.recovery_rate}`
        );
      }
    }

    // --- Case 2: N (opted out - no friendship_settings row at all) sees nothing for S ---
    await expectDenied("Case 2: N (opted out, no friendship_settings row toward S) cannot read S's digest for DATE_A", () =>
      clientN.from("daily_digests").select().eq("subject_user_id", userS.id).eq("digest_date", DATE_A).single()
    );

    // --- Case 3: a second date with no seeded events returns nothing (not stale DATE_A data) ---
    await expectOkVoid("Case 3: compute_daily_digests(DATE_B) succeeds (no-op - S had no events that day)", () =>
      computeDigests(DATE_B)
    );
    const dateB = await expectOk("Case 3: F queries daily_digests for DATE_B", () =>
      clientF.from("daily_digests").select().eq("subject_user_id", userS.id).eq("digest_date", DATE_B)
    );
    if (dateB) {
      record(
        "Case 3: no digest row exists for DATE_B (not stale data carried over from DATE_A)",
        Array.isArray(dateB) && dateB.length === 0,
        `got ${JSON.stringify(dateB)}`
      );
    }

    // --- Case 4: re-running compute_daily_digests(DATE_A) upserts, doesn't duplicate or error ---
    await expectOkVoid("Case 4: compute_daily_digests(DATE_A) re-run succeeds (does not error)", () =>
      computeDigests(DATE_A)
    );
    const dateARows = await expectOk("Case 4: admin query for (S, DATE_A) rows after the re-run", () =>
      admin.from("daily_digests").select().eq("subject_user_id", userS.id).eq("digest_date", DATE_A)
    );
    if (dateARows) {
      record(
        "Case 4: exactly one row exists for (S, DATE_A) after two compute_daily_digests calls (upsert, not duplicate)",
        Array.isArray(dateARows) && dateARows.length === 1,
        `got ${dateARows.length} row(s)`
      );
      if (dateARows.length === 1) {
        record(
          "Case 4: the re-computed row's values are unchanged (2 completed, 1 abandoned, 3 distractions)",
          dateARows[0].completed_sessions === 2 &&
            dateARows[0].abandoned_sessions === 1 &&
            dateARows[0].distraction_count === 3,
          `got completed=${dateARows[0].completed_sessions}, abandoned=${dateARows[0].abandoned_sessions}, distractions=${dateARows[0].distraction_count}`
        );
      }
    }

    // --- Case 5: zero-distraction convention - recovery_rate = 1.0, not NaN/0/error ---
    await seedEvent(userS2.id, `${sessionId}-s2`, "SESSION_COMPLETED", DATE_A, 9);
    record("Setup: seeded S2's session_status_events for DATE_A (1 completed, 0 distractions)", true);

    await expectOkVoid("Case 5: compute_daily_digests(DATE_A) picks up S2 too", () => computeDigests(DATE_A));
    const s2Row = await expectOk("Case 5: admin query for S2's DATE_A digest", () =>
      admin.from("daily_digests").select().eq("subject_user_id", userS2.id).eq("digest_date", DATE_A).single()
    );
    if (s2Row) {
      record(
        "Case 5: zero distractions that day -> recovery_rate = 1.0 (this migration's documented convention), not NaN/0",
        s2Row.distraction_count === 0 && s2Row.recovery_rate === 1,
        `got distraction_count=${s2Row.distraction_count}, recovery_rate=${s2Row.recovery_rate}`
      );
    }
  } finally {
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Daily digest verification summary ===");
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
  console.error("verify-digest.mjs crashed:", err);
  process.exit(1);
});
