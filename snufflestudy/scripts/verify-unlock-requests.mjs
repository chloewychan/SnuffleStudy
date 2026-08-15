// Live end-to-end proof for Task 8's Definition of Done (the RLS half - see
// src/domain/sites/siteRules.test.ts / src/background/alarmHandlers.test.ts /
// src/background/tabHandlers.test.ts for the domain-logic half, which needs no live database at
// all): "a soft-restricted site, once an unlock request is approved by a friend, becomes
// accessible without a distraction warning for the rest of the session; a denied or unanswered
// request leaves the restriction in place." This script proves the group-visibility/resolution
// half of that against the live project's RLS policies (supabase/migrations/
// 20260815000008_v2_unlock_request_group_visibility.sql) - a mocked unit test (see
// src/infrastructure/backend/unlockRequestApi.test.ts) can only prove createRequest/
// resolveRequest/fetchRelevantUnlockRequests call the right table/columns, not that the live
// database actually enforces the group-wide pending visibility and "first responder wins" race
// safety those policies claim to.
//
// Standalone Node script (same style/conventions as scripts/verify-nudges.mjs, the most recent -
// reuses its test-account helpers) - reads .env via dotenv/config, not part of `npm test`. Run
// directly: node scripts/verify-unlock-requests.mjs
//
// What it does:
//   1. Creates four ephemeral, auto-confirmed accounts via the service-role admin API: A
//      (requester), B and D (A's group-mates in a shared group G1), C (a friend in a DIFFERENT
//      group G2, sharing no group with A). Signs in as each via the anon-key client (password
//      auth), so every read/write below goes through the same RLS-bound client this codebase's
//      real unlockRequestApi.ts would use.
//   2. Case 1 (positive round trip): A creates a pending request R1. B (group-mate) can SELECT
//      it while pending, and successfully resolves it (approves). A (the requester) can still
//      read the resolved request afterward and sees the correct status/resolved_by.
//   3. Case 2 (negative - different group): A creates a pending request R2. C (no shared group
//      with A) can neither SELECT nor resolve (UPDATE) it while it's pending - this is exactly
//      the group-wide "notify the group" visibility this task adds, proven to NOT leak beyond
//      the requester's actual group(s).
//   4. Case 3 (first responder wins): A creates a pending request R3. B resolves it (approves)
//      first. D - a second group-mate who shares the same group - then attempts to resolve the
//      same (now non-pending) request and is denied, proving the race-safety design documented
//      in the migration (USING requires status = 'pending' for a non-requester).
//   5. Case 4 (denied stays denied, visible only to requester + resolver): A creates a pending
//      request R4. D resolves it (denies). B - a group-mate who did NOT resolve it - can no
//      longer SELECT it once it's resolved (matches Task 5's original guarantee, which this
//      task's migration comment promises to preserve). A (the requester) can still read it and
//      confirms status = denied.
//   6. Case 5 (fix round 1 - immutable-column trigger, migration 20260815000009): A creates a
//      pending request R5. B and D each attempt to resolve it while ALSO rewriting one of
//      hostname/session_id/requester_user_id in the same UPDATE call - each is rejected by the
//      BEFORE UPDATE trigger 20260815000009 added, and R5 is left completely unaffected
//      (still pending, original hostname) after each rejected attempt. A final well-formed
//      resolve (no pinned-column changes) from B still succeeds normally, proving the trigger
//      rejects only actual changes to the pinned columns, not resolves in general.
//   7. Cleans up every row it created and all four test accounts via the service-role client.
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
const PASSWORD = `Verify-UnlockRequests-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Mirrors scripts/verify-rls.mjs's expectDenied/expectOk exactly (same rationale: chaining
// `.single()` converts RLS's silent-filtering behavior into a hard error we can assert on,
// rather than leaning on the weaker "empty data" fallback).
async function expectDenied(name, fn) {
  try {
    const { data, error } = await fn();
    if (error) {
      record(name, true, `denied — ${error.message}`);
      return;
    }
    const isEmpty = data === null || (Array.isArray(data) && data.length === 0);
    if (isEmpty) {
      record(name, true, "denied — no rows returned/affected");
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
  const email = `unlock-req-test-${label}-${RUN_ID}@example.com`;
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

// Direct admin group setup (same shortcut scripts/verify-friend-sync.mjs takes) - the
// invite-code join flow itself is already proven by verify-rls.mjs; this script starts from
// "accounts already share (or don't share) a group" and focuses entirely on unlock_requests'
// own RLS policies.
//
// friend_groups.owner_user_id alone does NOT imply group membership - unlock_requests' new
// group-visibility policy joins group_memberships only, so the owner must ALSO get an explicit
// group_memberships row (mirrors friendGroupApi.ts's createGroup(), which inserts both rows for
// exactly this reason). `memberIds` here is every member INCLUDING the owner, not "everyone
// besides the owner" - a first version of this script omitted the owner from
// group_memberships and every group-membership check below failed as a result, since the
// requester (the owner in every case this script exercises) had no membership row for the
// group-visibility subquery to find.
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

// Mirrors unlockRequestApi.ts's createRequest() insert exactly (same table/columns).
async function createRequestAs(client, requesterUserId, sessionId, hostname) {
  return client
    .from("unlock_requests")
    .insert({
      session_id: sessionId,
      requester_user_id: requesterUserId,
      hostname,
      status: "pending",
    })
    .select()
    .single();
}

// Mirrors unlockRequestApi.ts's resolveRequest() update exactly (same table/columns, same
// .select().single() chaining so a zero-row match - e.g. a second friend racing to resolve an
// already-resolved request - surfaces as a hard error rather than a silent no-op).
async function resolveRequestAs(client, resolverUserId, requestId, decision) {
  return client
    .from("unlock_requests")
    .update({ status: decision, resolved_at: new Date().toISOString(), resolved_by: resolverUserId })
    .eq("id", requestId)
    .select()
    .single();
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as verify-rls.mjs /
  // verify-friend-sync.mjs / verify-nudges.mjs), so referencing rows must go before the rows/
  // users they reference.
  await admin.from("unlock_requests").delete().in("requester_user_id", userIds);
  // v2 Task 10: this script's G1 group has three members (A, B, D) - migration 20260815000012's
  // group_memberships_create_friendship_settings trigger now auto-creates a friendship_settings
  // row for every ordered pair among them the moment each member joins (six rows total here).
  // Those rows didn't exist before this migration, so this delete wasn't needed until now -
  // without it, the deleteUser() loop below would fail on the FK from friendship_settings to
  // auth.users (no ON DELETE CASCADE, same as every other table here).
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
  console.log("Creating ephemeral test accounts (A = requester, B/D = A's group-mates, C = different group)...");
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userD = await createTestUser("d");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userD.id, userC.id];

  try {
    const clientA = await signInAs(userA.email);
    const clientB = await signInAs(userB.email);
    const clientD = await signInAs(userD.email);
    const clientC = await signInAs(userC.email);
    record("Setup: A, B, D, C signed in via anon-key client", true);

    await createGroupWithMembers(
      userA.id,
      [userA.id, userB.id, userD.id],
      `Verify Unlock Requests G1 ${RUN_ID}`
    );
    await createGroupWithMembers(userC.id, [userC.id], `Verify Unlock Requests G2 (unrelated) ${RUN_ID}`);
    record("Setup: A/B/D share group G1; C is alone in unrelated group G2", true);

    const sessionId = `verify-unlock-requests-${RUN_ID}`;

    // --- Case 1: positive round trip - group-mate sees + resolves a pending request ---
    const r1 = await expectOk("Case 1: A creates a pending unlock request (R1)", () =>
      createRequestAs(clientA, userA.id, sessionId, "youtube.com")
    );

    if (r1) {
      await expectOk("Case 1: B (group-mate) can read R1 while pending", () =>
        clientB.from("unlock_requests").select().eq("id", r1.id).single()
      );

      const resolvedR1 = await expectOk("Case 1: B resolves R1 (approves)", () =>
        resolveRequestAs(clientB, userB.id, r1.id, "approved")
      );
      if (resolvedR1) {
        record(
          "Case 1: resolved R1 has status=approved, resolved_by=B",
          resolvedR1.status === "approved" && resolvedR1.resolved_by === userB.id,
          `got status=${resolvedR1.status}, resolved_by=${resolvedR1.resolved_by}`
        );
      }

      const rereadByA = await expectOk("Case 1: A (requester) can still read the resolved R1", () =>
        clientA.from("unlock_requests").select().eq("id", r1.id).single()
      );
      if (rereadByA) {
        record(
          "Case 1: A sees R1's resolved state correctly",
          rereadByA.status === "approved" && rereadByA.resolved_by === userB.id,
          `got status=${rereadByA.status}, resolved_by=${rereadByA.resolved_by}`
        );
      }
    }

    // --- Case 2: negative - a friend in a DIFFERENT group cannot see or resolve a pending request ---
    const r2 = await expectOk("Case 2: A creates a second pending unlock request (R2)", () =>
      createRequestAs(clientA, userA.id, sessionId, "instagram.com")
    );

    if (r2) {
      await expectDenied(
        "Case 2: C (different group, no overlap with A) cannot read pending R2",
        () => clientC.from("unlock_requests").select().eq("id", r2.id).single()
      );
      await expectDenied(
        "Case 2: C (different group) cannot resolve pending R2",
        () => resolveRequestAs(clientC, userC.id, r2.id, "approved")
      );
    }

    // --- Case 3: first responder wins ---
    const r3 = await expectOk("Case 3: A creates a third pending unlock request (R3)", () =>
      createRequestAs(clientA, userA.id, sessionId, "reddit.com")
    );

    if (r3) {
      await expectOk("Case 3: B resolves R3 first (approves)", () =>
        resolveRequestAs(clientB, userB.id, r3.id, "approved")
      );
      await expectDenied(
        "Case 3: D (second group-mate) resolving the now-non-pending R3 is denied (first responder wins)",
        () => resolveRequestAs(clientD, userD.id, r3.id, "denied")
      );
    }

    // --- Case 4: a denied request stays denied and visible only to requester + resolver ---
    const r4 = await expectOk("Case 4: A creates a fourth pending unlock request (R4)", () =>
      createRequestAs(clientA, userA.id, sessionId, "twitter.com")
    );

    if (r4) {
      const resolvedR4 = await expectOk("Case 4: D resolves R4 (denies)", () =>
        resolveRequestAs(clientD, userD.id, r4.id, "denied")
      );
      if (resolvedR4) {
        record(
          "Case 4: resolved R4 has status=denied, resolved_by=D",
          resolvedR4.status === "denied" && resolvedR4.resolved_by === userD.id,
          `got status=${resolvedR4.status}, resolved_by=${resolvedR4.resolved_by}`
        );
      }

      await expectDenied(
        "Case 4: B (group-mate who did NOT resolve it) can no longer read the now-denied R4",
        () => clientB.from("unlock_requests").select().eq("id", r4.id).single()
      );

      const rereadR4ByA = await expectOk("Case 4: A (requester) can still read the denied R4", () =>
        clientA.from("unlock_requests").select().eq("id", r4.id).single()
      );
      if (rereadR4ByA) {
        record(
          "Case 4: A sees R4's status=denied",
          rereadR4ByA.status === "denied",
          `got status=${rereadR4ByA.status}`
        );
      }
    }

    // --- Case 5 (fix round 1): immutable-column trigger blocks a resolve that also rewrites
    // hostname/session_id/requester_user_id ---
    // Covers the gap 20260815000008's WITH CHECK left open: it constrains only resolved_by/
    // status, so nothing in RLS itself stopped a resolving group member from ALSO rewriting
    // hostname/session_id/requester_user_id in the same UPDATE - which alarmHandlers.ts's
    // applyApprovedUnlockRequest would then trust blindly, letting a rogue/compromised group
    // member silently whitelist an arbitrary hostname in the requester's session. Migration
    // 20260815000009 closes this with a BEFORE UPDATE trigger that raises if any of those three
    // columns differ from OLD, independent of which RLS policy authorized the UPDATE attempt.
    const r5 = await expectOk("Case 5: A creates a fifth pending unlock request (R5)", () =>
      createRequestAs(clientA, userA.id, sessionId, "tiktok.com")
    );

    if (r5) {
      await expectDenied(
        "Case 5: B (group-mate) resolving R5 while ALSO rewriting hostname is rejected by the immutable-column trigger",
        () =>
          clientB
            .from("unlock_requests")
            .update({
              status: "approved",
              resolved_at: new Date().toISOString(),
              resolved_by: userB.id,
              hostname: "attacker-chosen.com",
            })
            .eq("id", r5.id)
            .select()
            .single()
      );

      // The trigger must have aborted the entire statement, not partially applied it - R5 should
      // still be pending, untouched, and still readable/resolvable normally afterward.
      const rereadR5 = await expectOk("Case 5: R5 is unaffected - still pending with its original hostname", () =>
        clientA.from("unlock_requests").select().eq("id", r5.id).single()
      );
      if (rereadR5) {
        record(
          "Case 5: R5's hostname/status were not changed by the rejected update",
          rereadR5.status === "pending" && rereadR5.hostname === "tiktok.com",
          `got status=${rereadR5.status}, hostname=${rereadR5.hostname}`
        );
      }

      await expectDenied(
        "Case 5: D (group-mate) resolving R5 while ALSO rewriting session_id is rejected by the immutable-column trigger",
        () =>
          clientD
            .from("unlock_requests")
            .update({
              status: "denied",
              resolved_at: new Date().toISOString(),
              resolved_by: userD.id,
              session_id: `${sessionId}-hijacked`,
            })
            .eq("id", r5.id)
            .select()
            .single()
      );

      await expectDenied(
        "Case 5: B resolving R5 while ALSO rewriting requester_user_id is rejected by the immutable-column trigger",
        () =>
          clientB
            .from("unlock_requests")
            .update({
              status: "approved",
              resolved_at: new Date().toISOString(),
              resolved_by: userB.id,
              requester_user_id: userB.id,
            })
            .eq("id", r5.id)
            .select()
            .single()
      );

      // A normal, well-formed resolve (no immutable-column changes) must still succeed - the
      // trigger should reject ONLY updates that actually change the pinned columns, not resolves
      // in general.
      const resolvedR5 = await expectOk("Case 5: B resolves R5 normally (no pinned-column changes) - still allowed", () =>
        resolveRequestAs(clientB, userB.id, r5.id, "approved")
      );
      if (resolvedR5) {
        record(
          "Case 5: resolved R5 has status=approved, hostname unchanged",
          resolvedR5.status === "approved" && resolvedR5.hostname === "tiktok.com",
          `got status=${resolvedR5.status}, hostname=${resolvedR5.hostname}`
        );
      }
    }
  } finally {
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Unlock requests verification summary ===");
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
  console.error("verify-unlock-requests.mjs crashed:", err);
  process.exit(1);
});
