// Live end-to-end proof for Task 6's Definition of Done: "two test accounts in the same group;
// starting a session on one account produces a status event the other account's poll picks up
// within one alarm interval, respecting whatever visibility settings are configured." A mocked
// unit test (see src/infrastructure/backend/sessionStatusSyncApi.test.ts) can only prove
// recordStatusEvent/fetchNewEventsForFriends call the right table/columns - it can't prove the
// live database's RLS policies actually gate visibility the way session_status_events' "group
// members can read visible friend session events" policy (supabase/migrations/
// 20260815000002_v2_rls_policies.sql) claims. This script proves that against the live project,
// using two (plus one, for the "no shared group" negative case) ephemeral test accounts.
//
// Standalone Node script (same style/conventions as scripts/verify-rls.mjs) - reads .env via
// dotenv/config, not part of `npm test`. Run directly: node scripts/verify-friend-sync.mjs
//
// What it does:
//   1. Creates ephemeral, auto-confirmed accounts A and B via the service-role admin API, and
//      puts them in a shared friend group via direct admin inserts (the invite-code join flow
//      itself is already proven by verify-rls.mjs - this script's focus is the event-sync path
//      that starts *after* two accounts are already in a group).
//   2. Signs in as each via the anon-key client (password auth), so every read/write below goes
//      through the same RLS-bound client this codebase's real sessionStatusSyncApi.ts would use.
//   3. A enables send_live_nudges toward B, then inserts a session_status_events row exactly the
//      way sessionStatusSyncApi.recordStatusEvent would - as A's own authenticated insert, same
//      table/columns.
//   4. Positive case: B queries session_status_events with the same unfiltered
//      occurred_at > sinceTimestamp shape fetchNewEventsForFriends uses, and the test asserts
//      A's event comes back with the expected display_label.
//   5. Negative case 1: A turns send_live_nudges off; a new event from A is confirmed absent
//      from B's next poll.
//   6. Negative case 2: a third account C (no shared group, no friendship_settings row at all)
//      is confirmed to see none of A's events.
//   7. Cleans up every row it created and all test accounts via the service-role client.
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
const PASSWORD = `Verify-FriendSync-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function createTestUser(label) {
  const email = `friend-sync-test-${label}-${RUN_ID}@example.com`;
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

// Mirrors sessionStatusSyncApi.recordStatusEvent's insert exactly (same table/columns) - the
// thing under test is whether the *database* (RLS) treats this the way the real client code
// would, not whether this script re-derives its own logic.
async function recordStatusEventAs(client, userId, event) {
  return client
    .from("session_status_events")
    .insert({
      user_id: userId,
      session_id: event.sessionId,
      type: event.type,
      display_label: event.displayLabel,
      occurred_at: new Date().toISOString(),
    })
    .select()
    .single();
}

// Mirrors sessionStatusSyncApi.fetchNewEventsForFriends exactly - unfiltered beyond the
// timestamp bound, trusting RLS to do all the visibility filtering.
async function fetchNewEventsForFriendsAs(client, sinceTimestamp) {
  return client
    .from("session_status_events")
    .select()
    .gt("occurred_at", new Date(sinceTimestamp).toISOString())
    .order("occurred_at", { ascending: true });
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs in the schema migration have no ON DELETE CASCADE (same note
  // as verify-rls.mjs), so referencing rows must go before the rows/users they reference.
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
  console.log("Creating ephemeral test accounts (A, B)...");
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userIds = [userA.id, userB.id];

  try {
    const clientA = await signInAs(userA.email);
    const clientB = await signInAs(userB.email);
    record("Setup: A and B signed in via anon-key client", true);

    // Direct admin inserts for group setup - the invite-code join flow itself is already
    // proven by verify-rls.mjs's "Functional" checks; this script starts from "two accounts
    // already share a group" and focuses entirely on the event-sync path after that.
    const groupId = crypto.randomUUID();
    const { error: groupErr } = await admin
      .from("friend_groups")
      .insert({ id: groupId, name: `Verify Friend Sync ${RUN_ID}`, owner_user_id: userA.id });
    const { error: memAErr } = await admin
      .from("group_memberships")
      .insert({ group_id: groupId, user_id: userA.id });
    const { error: memBErr } = await admin
      .from("group_memberships")
      .insert({ group_id: groupId, user_id: userB.id });
    record(
      "Setup: A and B share a group",
      !groupErr && !memAErr && !memBErr,
      [groupErr, memAErr, memBErr].filter(Boolean).map((e) => e.message).join("; ") || undefined
    );

    // A grants B visibility - written as A's own authenticated write (friendship_settings'
    // "users manage only their own settings rows" RLS policy requires user_id = auth.uid()).
    //
    // v2 Task 10: A and B already share a group by this point (set up just above), so migration
    // 20260815000012's group_memberships_create_friendship_settings trigger already auto-created
    // this exact (A, B) row the moment B joined (send_live_nudges defaults false since migration
    // 20260815000027_v2_default_legacy_visibility_to_false.sql - a v2 follow-up; this script's own
    // explicit `send_live_nudges: true` below is what actually grants the toggle now). A plain
    // `.insert()` here would still fail with a duplicate-key error regardless of the default;
    // `.upsert()` is robust to the row already existing while still proving A can write it.
    const { error: enableErr } = await clientA
      .from("friendship_settings")
      .upsert(
        { user_id: userA.id, friend_user_id: userB.id, send_live_nudges: true },
        { onConflict: "user_id,friend_user_id" }
      );
    record("Setup: A enables send_live_nudges toward B", !enableErr, enableErr?.message);

    // --- Positive case ---
    // sinceTimestamp simulates B's friend-poll alarm's last-checked cursor, one interval ago
    // (see friendPollState.ts / alarmHandlers.ts's handleFriendPollAlarm).
    const pollSince = Date.now() - 60_000;
    const { data: startedEvent, error: startErr } = await recordStatusEventAs(clientA, userA.id, {
      sessionId: `verify-friend-sync-${RUN_ID}`,
      type: "SESSION_STARTED",
      displayLabel: "started a focus session",
    });
    record(
      "A records a SESSION_STARTED event (simulating recordStatusEvent)",
      !startErr && !!startedEvent,
      startErr?.message
    );

    if (startedEvent) {
      const { data: polled, error: pollErr } = await fetchNewEventsForFriendsAs(clientB, pollSince);
      const found = (polled ?? []).find((r) => r.id === startedEvent.id);
      record(
        "Positive: B's poll (fetchNewEventsForFriends) picks up A's event with the expected display_label",
        !pollErr && !!found && found.display_label === "started a focus session",
        pollErr?.message ?? (found ? undefined : "event not found in B's poll results")
      );
    }

    // --- Negative case 1: send_live_nudges off ---
    const { error: disableErr } = await clientA
      .from("friendship_settings")
      .update({ send_live_nudges: false })
      .eq("user_id", userA.id)
      .eq("friend_user_id", userB.id);
    record("Setup: A disables send_live_nudges toward B", !disableErr, disableErr?.message);

    if (!disableErr) {
      const { data: secondEvent, error: secondErr } = await recordStatusEventAs(clientA, userA.id, {
        sessionId: `verify-friend-sync-${RUN_ID}`,
        type: "SESSION_PAUSED",
        displayLabel: "paused their session",
      });
      record(
        "A records a second event after disabling send_live_nudges",
        !secondErr && !!secondEvent,
        secondErr?.message
      );

      if (secondEvent) {
        const { data: polledAfterDisable, error: pollErr2 } = await fetchNewEventsForFriendsAs(
          clientB,
          pollSince
        );
        const leaked = (polledAfterDisable ?? []).find((r) => r.id === secondEvent.id);
        record(
          "Negative: B's poll does NOT include A's event once send_live_nudges is off",
          !pollErr2 && !leaked,
          leaked ? "event leaked despite send_live_nudges=false" : pollErr2?.message
        );
      }
    }

    // --- Negative case 2: no shared group / no friendship_settings row at all ---
    const userC = await createTestUser("c");
    userIds.push(userC.id);
    const clientC = await signInAs(userC.email);
    const { data: polledByC, error: pollErrC } = await fetchNewEventsForFriendsAs(clientC, pollSince);
    const visibleToC = (polledByC ?? []).find((r) => r.user_id === userA.id);
    record(
      "Negative: an unrelated account (no shared group, no friendship_settings row) sees none of A's events",
      !pollErrC && !visibleToC,
      visibleToC ? "unrelated account could see A's event" : pollErrC?.message
    );
  } finally {
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Friend-sync verification summary ===");
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
  console.error("verify-friend-sync.mjs crashed:", err);
  process.exit(1);
});
