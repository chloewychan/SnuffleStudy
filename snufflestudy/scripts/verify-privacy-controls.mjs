// Live end-to-end proof for Task 10's Definition of Done: "For each [privacy toggle], verify
// server-side ... toggle a field off, then attempt to read that field as the friend account - the
// read must fail or omit the field, not just be hidden by the UI." A mocked unit test (see
// src/infrastructure/backend/friendshipSettingsApi.test.ts /
// src/infrastructure/backend/sessionStatusSyncApi.test.ts) can only prove those files call the
// right table/RPC/columns - it can't prove the live database's RLS policies and SECURITY DEFINER
// RPC functions (supabase/migrations/20260815000012_v2_privacy_controls.sql) actually gate access
// the way they claim to. This script proves that against the live project.
//
// Standalone Node script (same style/conventions as scripts/verify-digest.mjs, the most recent/
// closest in shape - reuses its test-account/expectOk/expectDenied helpers) - reads .env via
// dotenv/config, not part of `npm test`. Run directly: node scripts/verify-privacy-controls.mjs
//
// What it does:
//   1. Creates three ephemeral, auto-confirmed accounts via the service-role admin API: S
//      (subject - the person whose data is being read), F (friend who shares a group with S), G
//      (a "friend" with every share_* toggle turned ON toward S, but who does NOT share a group
//      with S - exists purely to prove the group-membership floor holds independently of every
//      toggle's value, mirroring verify-digest.mjs's Case 2b / verify-friend-sync.mjs's negative
//      case 2). Signs in as each via the anon-key client (password auth).
//   2. Creates a group with S and F as members - BEFORE writing any friendship_settings row by
//      hand, confirms (via a service-role query) that migration 20260815000012's
//      group_memberships_create_friendship_settings trigger already auto-created BOTH directions
//      of the (S, F) settings row with every column at its schema default (this task's Part A).
//   3. Seeds three session_status_events rows for S directly via the service-role client
//      (bypasses RLS - the insert/recordStatusEvent write path itself is already proven live by
//      scripts/verify-friend-sync.mjs and unit-tested in sessionStatusSyncApi.test.ts; this
//      script's focus is the READ-side enforcement): one SESSION_STARTED with real goal_text, two
//      DISTRACTION_ATTEMPT with real hostnames.
//   4. For each of the five new fields, runs a negative case (toggle off - the read omits the
//      field, or is denied outright) then a positive case (toggle on - the read succeeds/returns
//      the real value), signed in as F:
//        - share_distraction_attempts: gates ROW-LEVEL visibility of DISTRACTION_ATTEMPT-type
//          rows via the plain baseline `.select()` (additive to the pre-existing baseline gate).
//        - share_current_domain / share_goal_text: gate the `hostname`/`goal_text` COLUMNS via
//          the fetch_friend_event_details RPC (plain RLS cannot express column-level redaction).
//        - share_intervention_count: gates the fetch_friend_intervention_count RPC (denies
//          outright via a raised exception when off).
//        - share_full_history: gates the fetch_friend_full_history RPC (denies outright when
//          off); once on, additionally proves the DISTRACTION_ATTEMPT-type rows within that
//          history are STILL excluded unless share_distraction_attempts is ALSO on - the "additive
//          gate" requirement - by toggling share_distraction_attempts off/on around this case.
//   5. Group-membership floor: G, with every one of the five toggles turned on toward S but no
//      shared group, is denied on every one of the five reads above.
//   6. Column-leak regression check: even as F (who by this point has full read access, including
//      both new toggles), the app's actual narrowed baseline column list
//      ("id, user_id, session_id, type, display_label, occurred_at" - must match
//      sessionStatusSyncApi.ts's BASELINE_EVENT_COLUMNS exactly) never returns hostname/goal_text
//      keys on the row objects at all, regardless of toggle state.
//   7. Cleans up every row and account it created via the service-role client.
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
const PASSWORD = `Verify-Privacy-${crypto.randomUUID()}!`;

// Must match sessionStatusSyncApi.ts's BASELINE_EVENT_COLUMNS exactly - the whole point of check
// #6 above is proving the app's real column list never widens to include hostname/goal_text.
const BASELINE_EVENT_COLUMNS = "id, user_id, session_id, type, display_label, occurred_at";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Mirrors scripts/verify-digest.mjs's expectDenied exactly: passes when the call errors OR
// returns empty data (RLS's silent-row-exclusion) - covers both this schema's failure modes
// (a raised exception from fetch_friend_intervention_count/fetch_friend_full_history, and a
// plain empty result set from a SELECT or from fetch_friend_event_details).
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

async function createTestUser(label) {
  const email = `privacy-test-${label}-${RUN_ID}@example.com`;
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

// Mirrors verify-digest.mjs's/verify-unlock-requests.mjs's createGroupWithMembers exactly.
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

// Seeds a session_status_events row directly via the service-role client (bypasses RLS - the
// write path itself is already proven live by verify-friend-sync.mjs and unit-tested in
// sessionStatusSyncApi.test.ts; this script's focus is the read-side RLS/RPC enforcement).
async function seedEvent(userId, sessionId, type, { hostname = null, goalText = null } = {}) {
  const { data, error } = await admin
    .from("session_status_events")
    .insert({
      user_id: userId,
      session_id: sessionId,
      type,
      display_label: type === "DISTRACTION_ATTEMPT" ? "got distracted" : "started a focus session",
      occurred_at: new Date().toISOString(),
      hostname,
      goal_text: goalText,
    })
    .select()
    .single();
  if (error || !data) throw new Error(`Failed to seed ${type} event for ${userId}: ${error?.message}`);
  return data;
}

async function updateSettingsAsSubject(client, subjectId, friendId, patch) {
  return client
    .from("friendship_settings")
    .update(patch)
    .eq("user_id", subjectId)
    .eq("friend_user_id", friendId)
    .select()
    .single();
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as every other
  // verify-*.mjs script), so referencing rows must go before the rows/users they reference.
  await admin.from("session_status_events").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("friend_user_id", userIds);
  await admin.from("group_memberships").delete().in("user_id", userIds);
  await admin.from("friend_groups").delete().in("owner_user_id", userIds);

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`  Failed to delete test user ${id}: ${error.message}`);
  }
  console.log("Cleanup done.");
}

async function main() {
  console.log(
    "Creating ephemeral test accounts (S = subject, F = in-group friend, G = opted-in-but-no-shared-group)..."
  );
  const userS = await createTestUser("s");
  const userF = await createTestUser("f");
  const userG = await createTestUser("g");
  const userIds = [userS.id, userF.id, userG.id];

  try {
    const clientS = await signInAs(userS.email);
    const clientF = await signInAs(userF.email);
    const clientG = await signInAs(userG.email);
    record("Setup: S, F, G signed in via anon-key client", true);

    // --- (b) Trigger-based auto-creation of friendship_settings rows on group join ---
    await createGroupWithMembers(userS.id, [userS.id, userF.id], `Verify Privacy Controls G1 ${RUN_ID}`);
    record("Setup: S and F share a group (G does not)", true);

    const rowsAfterJoin = await expectOk(
      "Trigger: BOTH directions of the (S, F) friendship_settings row exist immediately after the group join, with no manual insert",
      () =>
        admin
          .from("friendship_settings")
          .select()
          .or(
            `and(user_id.eq.${userS.id},friend_user_id.eq.${userF.id}),and(user_id.eq.${userF.id},friend_user_id.eq.${userS.id})`
          )
    );
    if (rowsAfterJoin) {
      record(
        "Trigger: exactly two rows exist ((S->F) and (F->S))",
        rowsAfterJoin.length === 2,
        `got ${rowsAfterJoin.length} row(s)`
      );
      const allDefaults = rowsAfterJoin.every(
        (r) =>
          r.receive_live_nudges === true &&
          r.send_live_nudges === true &&
          r.receive_daily_digest === true &&
          r.share_distraction_attempts === false &&
          r.share_current_domain === false &&
          r.share_goal_text === false &&
          r.share_intervention_count === false &&
          r.share_full_history === false
      );
      record(
        "Trigger: both auto-created rows have every column at its schema default (three pre-existing true, five new share_* false)",
        allDefaults,
        allDefaults ? undefined : JSON.stringify(rowsAfterJoin)
      );
    }

    // --- Seed S's session_status_events ---
    const sessionId = `verify-privacy-${RUN_ID}`;
    const evStart = await seedEvent(userS.id, sessionId, "SESSION_STARTED", {
      goalText: "Finish the calculus problem set",
    });
    const evDistraction1 = await seedEvent(userS.id, sessionId, "DISTRACTION_ATTEMPT", {
      hostname: "youtube.com",
    });
    const evDistraction2 = await seedEvent(userS.id, sessionId, "DISTRACTION_ATTEMPT", {
      hostname: "reddit.com",
    });
    record("Setup: seeded S's session_status_events (1 SESSION_STARTED, 2 DISTRACTION_ATTEMPT)", true);

    // === Case 1: share_distraction_attempts (row-level RLS gate, additive to the baseline gate) ===
    await expectDenied(
      "Case 1 negative: F cannot read a DISTRACTION_ATTEMPT row via the baseline select while share_distraction_attempts is off (default)",
      () =>
        clientF
          .from("session_status_events")
          .select(BASELINE_EVENT_COLUMNS)
          .eq("id", evDistraction1.id)
          .single()
    );

    const case1Update = await expectOk("Setup: S turns share_distraction_attempts ON toward F", () =>
      updateSettingsAsSubject(clientS, userS.id, userF.id, { share_distraction_attempts: true })
    );
    if (case1Update) {
      const positiveRow = await expectOk(
        "Case 1 positive: F CAN read the DISTRACTION_ATTEMPT row via the baseline select once share_distraction_attempts is on",
        () =>
          clientF
            .from("session_status_events")
            .select(BASELINE_EVENT_COLUMNS)
            .eq("id", evDistraction1.id)
            .single()
      );
      if (positiveRow) {
        record(
          "Case 1 positive: the returned row is the right one",
          positiveRow.id === evDistraction1.id,
          `got id=${positiveRow.id}`
        );
      }
    }

    // === Case 2: share_current_domain (fetch_friend_event_details RPC - hostname redaction) ===
    const negDetails = await expectOk(
      "Case 2 negative: fetch_friend_event_details succeeds (row visible per Case 1) while share_current_domain is off",
      () => clientF.rpc("fetch_friend_event_details", { p_event_ids: [evDistraction1.id] })
    );
    if (negDetails) {
      const row = negDetails.find((r) => r.id === evDistraction1.id);
      record(
        "Case 2 negative: hostname is null (omitted) while share_current_domain is off (default)",
        !!row && row.hostname === null,
        `got ${JSON.stringify(row)}`
      );
    }

    await expectOk("Setup: S turns share_current_domain ON toward F", () =>
      updateSettingsAsSubject(clientS, userS.id, userF.id, { share_current_domain: true })
    );
    const posDetails = await expectOk(
      "Case 2 positive: fetch_friend_event_details succeeds once share_current_domain is on",
      () => clientF.rpc("fetch_friend_event_details", { p_event_ids: [evDistraction1.id] })
    );
    if (posDetails) {
      const row = posDetails.find((r) => r.id === evDistraction1.id);
      record(
        "Case 2 positive: hostname is the real value once share_current_domain is on",
        !!row && row.hostname === "youtube.com",
        `got ${JSON.stringify(row)}`
      );
    }

    // === Case 3: share_goal_text (fetch_friend_event_details RPC - goal_text redaction) ===
    // Uses the SESSION_STARTED row - visible to F via the pre-existing baseline gate alone (no
    // distraction-specific gate applies to this event type), isolating goal_text's own toggle.
    const negGoal = await expectOk(
      "Case 3 negative: fetch_friend_event_details succeeds for the SESSION_STARTED row while share_goal_text is off",
      () => clientF.rpc("fetch_friend_event_details", { p_event_ids: [evStart.id] })
    );
    if (negGoal) {
      const row = negGoal.find((r) => r.id === evStart.id);
      record(
        "Case 3 negative: goal_text is null (omitted) while share_goal_text is off (default)",
        !!row && row.goal_text === null,
        `got ${JSON.stringify(row)}`
      );
    }

    await expectOk("Setup: S turns share_goal_text ON toward F", () =>
      updateSettingsAsSubject(clientS, userS.id, userF.id, { share_goal_text: true })
    );
    const posGoal = await expectOk(
      "Case 3 positive: fetch_friend_event_details succeeds once share_goal_text is on",
      () => clientF.rpc("fetch_friend_event_details", { p_event_ids: [evStart.id] })
    );
    if (posGoal) {
      const row = posGoal.find((r) => r.id === evStart.id);
      record(
        "Case 3 positive: goal_text is the real value once share_goal_text is on",
        !!row && row.goal_text === "Finish the calculus problem set",
        `got ${JSON.stringify(row)}`
      );
    }

    // === Case 4: share_intervention_count (fetch_friend_intervention_count RPC) ===
    await expectDenied(
      "Case 4 negative: fetch_friend_intervention_count is denied while share_intervention_count is off (default)",
      () => clientF.rpc("fetch_friend_intervention_count", { p_subject_user_id: userS.id, p_since: null })
    );

    await expectOk("Setup: S turns share_intervention_count ON toward F", () =>
      updateSettingsAsSubject(clientS, userS.id, userF.id, { share_intervention_count: true })
    );
    const countResult = await expectOk(
      "Case 4 positive: fetch_friend_intervention_count succeeds once share_intervention_count is on",
      () => clientF.rpc("fetch_friend_intervention_count", { p_subject_user_id: userS.id, p_since: null })
    );
    if (countResult !== null) {
      record(
        "Case 4 positive: the count matches the two seeded DISTRACTION_ATTEMPT events",
        countResult === 2,
        `got ${countResult}`
      );
    }

    // === Case 5: share_full_history (fetch_friend_full_history RPC), including the additive
    // distraction-specific gate on top of it ===
    await expectDenied(
      "Case 5 negative: fetch_friend_full_history is denied while share_full_history is off (default)",
      () => clientF.rpc("fetch_friend_full_history", { p_subject_user_id: userS.id })
    );

    // Isolate the additive gate: turn share_distraction_attempts back OFF (it was turned on for
    // Case 1) so full_history's grant alone is what's under test for this sub-case.
    await expectOk("Setup: S turns share_distraction_attempts back OFF, then share_full_history ON toward F", async () => {
      const r1 = await updateSettingsAsSubject(clientS, userS.id, userF.id, {
        share_distraction_attempts: false,
      });
      if (r1.error) return r1;
      return updateSettingsAsSubject(clientS, userS.id, userF.id, { share_full_history: true });
    });

    const historyWithoutDistraction = await expectOk(
      "Case 5a: fetch_friend_full_history succeeds once share_full_history is on",
      () => clientF.rpc("fetch_friend_full_history", { p_subject_user_id: userS.id })
    );
    if (historyWithoutDistraction) {
      const ids = historyWithoutDistraction.map((r) => r.id);
      record(
        "Case 5a (additive gate): DISTRACTION_ATTEMPT rows are STILL excluded from full history while share_distraction_attempts is off, even though share_full_history is on",
        !ids.includes(evDistraction1.id) && !ids.includes(evDistraction2.id) && ids.includes(evStart.id),
        `got ids=${JSON.stringify(ids)}`
      );
    }

    await expectOk("Setup: S turns share_distraction_attempts back ON toward F", () =>
      updateSettingsAsSubject(clientS, userS.id, userF.id, { share_distraction_attempts: true })
    );
    const historyWithDistraction = await expectOk(
      "Case 5b: fetch_friend_full_history re-queried after re-enabling share_distraction_attempts",
      () => clientF.rpc("fetch_friend_full_history", { p_subject_user_id: userS.id })
    );
    if (historyWithDistraction) {
      const ids = historyWithDistraction.map((r) => r.id);
      record(
        "Case 5b (additive gate): DISTRACTION_ATTEMPT rows now appear once BOTH share_full_history and share_distraction_attempts are on",
        ids.includes(evDistraction1.id) && ids.includes(evDistraction2.id) && ids.includes(evStart.id),
        `got ids=${JSON.stringify(ids)}`
      );
    }

    // === (a) Group-membership floor: G has every one of the five toggles ON toward S, but does
    // NOT share a group with S - every read must still be denied. ===
    // v2 Task 10 fix round 1 (supabase/migrations/20260815000013_v2_tighten_friendship_settings_insert.sql):
    // friendship_settings' own INSERT policy now requires users_share_a_group(user_id,
    // friend_user_id), so S's own client can no longer create this row via a normal write at all
    // - S and G share no group. Seeded via the service-role client instead (bypasses RLS
    // entirely, same pattern verify-digest.mjs's Case 2b setup now also uses for the identical
    // reason) so this floor test still exercises what it always meant to: a row in this exact
    // (every toggle on, no shared group) state, however it came to exist, must still be denied on
    // every READ path below - defense-in-depth, independent of whether the write path that could
    // produce this state even exists anymore.
    await expectOk("Setup: S grants G every one of the five new toggles (but G shares no group with S)", () =>
      admin.from("friendship_settings").upsert(
        {
          user_id: userS.id,
          friend_user_id: userG.id,
          share_distraction_attempts: true,
          share_current_domain: true,
          share_goal_text: true,
          share_intervention_count: true,
          share_full_history: true,
        },
        { onConflict: "user_id,friend_user_id" }
      )
    );

    await expectDenied(
      "Group floor: G cannot read the DISTRACTION_ATTEMPT row via the baseline select despite share_distraction_attempts=true (no shared group)",
      () =>
        clientG
          .from("session_status_events")
          .select(BASELINE_EVENT_COLUMNS)
          .eq("id", evDistraction1.id)
          .single()
    );
    await expectDenied(
      "Group floor: G's fetch_friend_event_details returns nothing for S's events despite share_current_domain/share_goal_text=true (no shared group)",
      () =>
        clientG.rpc("fetch_friend_event_details", {
          p_event_ids: [evStart.id, evDistraction1.id, evDistraction2.id],
        })
    );
    await expectDenied(
      "Group floor: G's fetch_friend_intervention_count is denied despite share_intervention_count=true (no shared group)",
      () => clientG.rpc("fetch_friend_intervention_count", { p_subject_user_id: userS.id, p_since: null })
    );
    await expectDenied(
      "Group floor: G's fetch_friend_full_history is denied despite share_full_history=true (no shared group)",
      () => clientG.rpc("fetch_friend_full_history", { p_subject_user_id: userS.id })
    );

    // === (c) Column-leak regression check: the narrowed baseline query never returns
    // hostname/goal_text, even for a viewer (F) who by now has full legitimate access to both. ===
    const baselineRows = await expectOk(
      "Column-leak check: F's baseline select (real BASELINE_EVENT_COLUMNS list) succeeds",
      () =>
        clientF
          .from("session_status_events")
          .select(BASELINE_EVENT_COLUMNS)
          .in("id", [evStart.id, evDistraction1.id, evDistraction2.id])
    );
    if (baselineRows) {
      const anyLeaked = baselineRows.some(
        (r) => Object.prototype.hasOwnProperty.call(r, "hostname") ||
          Object.prototype.hasOwnProperty.call(r, "goal_text")
      );
      record(
        "Column-leak check: none of the returned rows include a hostname or goal_text key, even though F now has full legitimate access to both fields via the RPCs",
        !anyLeaked && baselineRows.length === 3,
        `got keys=${baselineRows.map((r) => Object.keys(r).join(",")).join(" | ")}`
      );
    }
  } finally {
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Privacy controls verification summary ===");
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
  console.error("verify-privacy-controls.mjs crashed:", err);
  process.exit(1);
});
