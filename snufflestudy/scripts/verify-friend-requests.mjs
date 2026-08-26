// Live end-to-end proof for v3.4 Task 3's Definition of Done: unlock_requests/
// temp_passcode_requests/session_end_requests are consolidated into one kind-discriminated
// friend_requests table, one RLS policy set (supabase/migrations/
// 20260815000041_v3.4_friend_requests.sql), against the live dev Supabase project - not just
// inspected SQL.
//
// Standalone Node script (same style/conventions as scripts/verify-friendships.mjs/
// verify-temp-passcode.mjs/verify-unlock-requests.mjs) - reads .env via dotenv/config, not part
// of `npm test`. Run directly: node scripts/verify-friend-requests.mjs
//
// What it does, using four ephemeral, auto-confirmed test accounts (A = requester, B = A's
// friend used as the assigned friend_user_id on kind-specific requests, D = A's OTHER friend,
// used both for "any friend can resolve a group-wide request" and "a friend who is neither
// assigned nor the requester cannot see/resolve an assigned request", C = a stranger with no
// friendship to A at all):
//
//   Setup: friendships(A,B) and friendships(A,D) are inserted directly via the service-role
//   client (mirrors verify-temp-passcode.mjs's "direct admin group setup" shortcut) - Task 2's
//   own redeem_invite_code() path is already covered by verify-friendships.mjs, so this script
//   doesn't re-prove connection *formation*, only what friend_requests' RLS does once are_friends()
//   is true.
//
//   Case 1 - site_unlock, friend_user_id: null (group-wide, first-responder-wins):
//     A creates one. C (a stranger, not A's friend at all) can neither SELECT it nor resolve it.
//     D (A's friend, not specifically assigned - there IS no assignment on this kind of request)
//     CAN resolve it, proving "any of the requester's friends" really does mean any of them, not
//     a hardcoded one.
//
//   Case 2 - Decision 4's preserved quirk, POSITIVE case: the requester resolving their OWN
//     pending request succeeds, for both site_unlock and session_end (not a new behavior this
//     task introduces - a pre-existing shipped quirk this task's consolidated policy deliberately
//     preserves, per Decision 4 - this proves it still works post-consolidation, not that it's
//     "correct" in some absolute sense).
//
//   Case 3 - Decision 3's SECURITY-CRITICAL negative case: a site_temp_pass request assigned to
//     B. B's own plain-client UPDATE attempting status='approved' directly (bypassing the
//     approve-temp-passcode Edge Function entirely) MUST be denied by RLS's WITH CHECK clause.
//     Confirms the row is still 'pending' afterward (not partially applied). Then, informationally
//     (not scored pass/fail - see verify-temp-passcode.mjs's identical precedent for why: Edge
//     Function deployment happens at the two-account QA gate, not per implementation task), tries
//     the real approve-temp-passcode Edge Function via B's own authenticated client and reports
//     what it gets back.
//
//   Case 4 - a friend who is NEITHER the assigned friend_user_id NOR the requester cannot SELECT
//     or UPDATE an assigned (non-null friend_user_id) request: D (A's friend, but not the B who
//     is assigned to the Case 3 site_temp_pass request) gets zero rows back on a direct SELECT,
//     and a no-op (zero rows affected) on a direct UPDATE attempting to deny it.
//
//   Case 5 - the immutable-columns trigger: a direct UPDATE that pairs a legitimate
//     status/resolved_by change with an attempted change to an immutable column (kind,
//     requester_user_id, friend_user_id, hostname, session_id, message - tried individually) is
//     rejected outright by the trigger's raised exception, and the row is confirmed unchanged
//     afterward. A separate, otherwise-identical UPDATE that changes ONLY status/resolved_at/
//     resolved_by/expires_at (the actual point of resolving a request) is confirmed to still
//     succeed against that same row.
//
//   Case 6 - unlock_requests/temp_passcode_requests/session_end_requests are actually gone: a
//     service-role `select * from <table> limit 1` against each fails with a
//     relation-does-not-exist-shaped error, not merely an RLS-empty result (service-role bypasses
//     RLS entirely, so this proves the table itself is gone, not just newly inaccessible).
//
//   Cleanup: deletes every friend_requests/friendships row and test account this script created,
//   then re-queries + calls listUsers() to confirm nothing was left behind.
//
//   Prints a pass/fail summary and exits non-zero if anything failed.

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
const PASSWORD = `Verify-FriendRequests-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Mirrors scripts/verify-rls.mjs's/verify-temp-passcode.mjs's expectDenied/expectOk exactly.
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
  const email = `friend-requests-test-${label}-${RUN_ID}@example.com`;
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

async function signIn(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`Failed to sign in as ${email}: ${error?.message}`);
  return client;
}

// Direct admin insert - mirrors verify-temp-passcode.mjs's "direct admin group setup" shortcut,
// adapted to the pairwise friendships table (Task 2). Canonical order (a < b) enforced here
// exactly the way friendshipApi.ts's own redeemInviteCode/removeFriend do.
async function createFriendshipDirect(userIdX, userIdY, initiatedBy) {
  const a = userIdX < userIdY ? userIdX : userIdY;
  const b = userIdX < userIdY ? userIdY : userIdX;
  const { error } = await admin.from("friendships").insert({
    user_id_a: a,
    user_id_b: b,
    initiated_by: initiatedBy,
  });
  if (error) throw new Error(`Failed to seed friendship (${userIdX}, ${userIdY}): ${error.message}`);
}

// Mirrors friendRequestApi.ts's createRequest() insert exactly (same table/columns/narrowed
// select) - the actual RLS-bound write path the app itself uses.
const COLUMNS =
  "id, kind, requester_user_id, friend_user_id, message, status, requested_at, resolved_at, resolved_by, hostname, session_id, expires_at";

async function createRequestAs(client, kind, requesterId, { friendUserId, hostname, sessionId, message } = {}) {
  return client
    .from("friend_requests")
    .insert({
      kind,
      session_id: sessionId,
      requester_user_id: requesterId,
      friend_user_id: friendUserId ?? null,
      hostname: hostname ?? null,
      status: "pending",
      ...(message ? { message } : {}),
    })
    .select(COLUMNS)
    .single();
}

// Mirrors friendRequestApi.ts's resolveRequest() exactly (plain-client UPDATE path - valid for
// denying any kind, or approving site_unlock/session_end; approving site_temp_pass must go
// through the Edge Function instead, per Decision 3 - see Case 3 below).
function resolveRequestAs(client, requestId, decision, resolverId) {
  return client
    .from("friend_requests")
    .update({ status: decision, resolved_at: new Date().toISOString(), resolved_by: resolverId })
    .eq("id", requestId)
    .select()
    .single();
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as every other
  // verify-*.mjs script) - referencing rows must go before the users they reference.
  await admin.from("friend_requests").delete().in("requester_user_id", userIds);
  await admin.from("friend_requests").delete().in("friend_user_id", userIds);
  await admin.from("friendships").delete().in("user_id_a", userIds);
  await admin.from("friendships").delete().in("user_id_b", userIds);
  await admin.from("friendship_settings").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("friend_user_id", userIds);
  await admin.from("profiles").delete().in("user_id", userIds);

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error && !error.message?.includes("User not found")) {
      console.error(`  Failed to delete test user ${id}: ${error.message}`);
    }
  }
  console.log("Cleanup done.");
}

// Re-queries every table this script touched, scoped to this run's own synthetic values, to
// confirm cleanup() actually left nothing behind - not just that its calls didn't error. Same
// convention verify-temp-passcode.mjs's/verify-friendships.mjs's confirmNoLeftovers use.
async function confirmNoLeftovers(userIds, emails) {
  const leftoverRequests = await admin
    .from("friend_requests")
    .select("id")
    .or(`requester_user_id.in.(${userIds.join(",")}),friend_user_id.in.(${userIds.join(",")})`);
  record(
    "Cleanup check: no leftover friend_requests rows for these test users",
    (leftoverRequests.data ?? []).length === 0,
    `found ${leftoverRequests.data?.length ?? 0}`
  );

  const leftoverFriendships = await admin
    .from("friendships")
    .select("user_id_a")
    .or(`user_id_a.in.(${userIds.join(",")}),user_id_b.in.(${userIds.join(",")})`);
  record(
    "Cleanup check: no leftover friendships rows for these test users",
    (leftoverFriendships.data ?? []).length === 0,
    `found ${leftoverFriendships.data?.length ?? 0}`
  );

  const { data: usersPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const email of emails) {
    const stillThere = (usersPage?.users ?? []).some((u) => u.email === email);
    record(`Cleanup check: auth.users no longer contains ${email}`, !stillThere);
  }
}

async function main() {
  console.log(
    "Creating ephemeral test accounts (A = requester, B = A's friend/assigned approver, " +
      "D = A's OTHER friend, C = unconnected stranger)..."
  );
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userD = await createTestUser("d");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userD.id, userC.id];
  const emails = [userA.email, userB.email, userD.email, userC.email];

  try {
    const clientA = await signIn(userA.email);
    const clientB = await signIn(userB.email);
    const clientD = await signIn(userD.email);
    const clientC = await signIn(userC.email);
    record("Setup: A, B, D, C signed in via anon-key client", true);

    await createFriendshipDirect(userA.id, userB.id, userA.id);
    await createFriendshipDirect(userA.id, userD.id, userA.id);
    record("Setup: friendships(A,B) and friendships(A,D) seeded directly; C shares no friendship with A", true);

    const sessionId = `verify-friend-requests-${RUN_ID}`;

    // === Case 1: site_unlock, friend_user_id: null (group-wide/first-responder-wins) ===
    console.log("\n=== Case 1: site_unlock with friend_user_id: null is resolvable by ANY friend, not by a stranger ===");
    const r1 = await createRequestAs(clientA, "site_unlock", userA.id, {
      hostname: "youtube.com",
      sessionId,
    });
    record("Case 1: A creates a group-wide site_unlock request (friend_user_id: null)", !r1.error && !!r1.data, r1.error?.message);
    const r1Id = r1.data?.id;

    if (r1Id) {
      await expectDenied(
        "Case 1: C (not A's friend at all) cannot SELECT the pending request",
        () => clientC.from("friend_requests").select().eq("id", r1Id).single()
      );
      await expectDenied(
        "Case 1: C (not A's friend at all) cannot resolve the pending request",
        () => resolveRequestAs(clientC, r1Id, "approved", userC.id)
      );

      const dResolve = await expectOk(
        "Case 1: D (A's friend, not specifically assigned - there's no assignment on this kind) CAN resolve it",
        () => resolveRequestAs(clientD, r1Id, "approved", userD.id)
      );
      if (dResolve) {
        record(
          "Case 1: resolved row shows status='approved', resolved_by=D",
          dResolve.status === "approved" && dResolve.resolved_by === userD.id,
          `got status=${dResolve.status}, resolved_by=${dResolve.resolved_by}`
        );
      }
    }

    // === Case 2: Decision 4's preserved quirk, POSITIVE case - requester self-resolves ===
    console.log("\n=== Case 2: Decision 4 (preserved quirk) - the requester CAN resolve their own pending request ===");
    const r2unlock = await createRequestAs(clientA, "site_unlock", userA.id, {
      friendUserId: userB.id,
      hostname: "twitch.tv",
      sessionId,
    });
    record("Case 2 setup: A creates a site_unlock request assigned to B", !r2unlock.error && !!r2unlock.data, r2unlock.error?.message);
    if (r2unlock.data?.id) {
      await expectOk(
        "Case 2: A (the requester) resolves their OWN pending site_unlock request (approve) - succeeds",
        () => resolveRequestAs(clientA, r2unlock.data.id, "approved", userA.id)
      );
    }

    const r2end = await createRequestAs(clientA, "session_end", userA.id, {
      friendUserId: userB.id,
      sessionId,
    });
    record("Case 2 setup: A creates a session_end request assigned to B", !r2end.error && !!r2end.data, r2end.error?.message);
    if (r2end.data?.id) {
      await expectOk(
        "Case 2: A (the requester) resolves their OWN pending session_end request (approve) - succeeds",
        () => resolveRequestAs(clientA, r2end.data.id, "approved", userA.id)
      );
    }

    // === Case 3: Decision 3, SECURITY-CRITICAL negative case ===
    console.log(
      "\n=== Case 3 (SECURITY-CRITICAL, Decision 3): a plain-client UPDATE cannot approve a site_temp_pass request ==="
    );
    const r3 = await createRequestAs(clientA, "site_temp_pass", userA.id, {
      friendUserId: userB.id,
      hostname: "instagram.com",
      sessionId,
    });
    record("Case 3 setup: A creates a site_temp_pass request assigned to B", !r3.error && !!r3.data, r3.error?.message);
    const r3Id = r3.data?.id;

    if (r3Id) {
      await expectDenied(
        "Case 3: B (the assigned friend) attempting a DIRECT plain-client UPDATE to status='approved' is REJECTED by RLS",
        () => resolveRequestAs(clientB, r3Id, "approved", userB.id)
      );

      const { data: r3AfterDeniedAttempt } = await admin
        .from("friend_requests")
        .select("status, expires_at")
        .eq("id", r3Id)
        .single();
      record(
        "Case 3: the request is still 'pending' with no expires_at after the rejected direct-UPDATE attempt (not partially applied)",
        r3AfterDeniedAttempt?.status === "pending" && r3AfterDeniedAttempt?.expires_at === null,
        `got status=${r3AfterDeniedAttempt?.status}, expires_at=${r3AfterDeniedAttempt?.expires_at}`
      );

      // Informational only, not scored - mirrors verify-temp-passcode.mjs's identical precedent:
      // Edge Function deployment happens at the two-account QA gate, not per implementation task,
      // so a non-200 here reflects deployment timing, not a defect in this task's own work (the
      // function's source already targets friend_requests/kind='site_temp_pass' - see
      // supabase/functions/approve-temp-passcode/index.ts).
      const { data: edgeData, error: edgeError } = await clientB.functions.invoke("approve-temp-passcode", {
        body: { requestId: r3Id },
      });
      console.log(
        `  [INFO, not scored] live approve-temp-passcode invoke: ${
          edgeError ? `error - ${edgeError.message}` : `ok - ${JSON.stringify(edgeData)}`
        }`
      );
      if (!edgeError && edgeData?.hostname && typeof edgeData.expiresAt === "number") {
        record(
          "Case 3 [bonus, exercised live]: approve-temp-passcode Edge Function approval succeeded and set expires_at",
          true,
          `hostname=${edgeData.hostname}, expiresAt=${edgeData.expiresAt}`
        );
      } else {
        console.log(
          "  Falling back to a service-role-simulated approval (what the Edge Function itself does " +
            "server-side) so Case 4 below still has a genuinely non-pending assigned request to test against."
        );
        await admin
          .from("friend_requests")
          .update({
            status: "approved",
            expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            resolved_at: new Date().toISOString(),
          })
          .eq("id", r3Id)
          .eq("status", "pending");
      }
    }

    // === Case 4: a friend who is neither assigned nor the requester cannot see/resolve it ===
    console.log(
      "\n=== Case 4: D (A's friend, but NOT the assigned B, and not the requester) cannot SELECT or UPDATE the assigned request ==="
    );
    if (r3Id) {
      await expectDenied(
        "Case 4: D cannot SELECT the request assigned to B",
        () => clientD.from("friend_requests").select().eq("id", r3Id).single()
      );
      await expectDenied(
        "Case 4: D cannot UPDATE (deny) the request assigned to B",
        () => resolveRequestAs(clientD, r3Id, "denied", userD.id)
      );
    }

    // === Case 5: immutable-columns trigger ===
    console.log("\n=== Case 5: the immutable-columns trigger rejects changes to identity/context columns ===");
    const r5 = await createRequestAs(clientA, "site_unlock", userA.id, {
      hostname: "reddit.com",
      sessionId,
      message: "original message",
    });
    record("Case 5 setup: A creates a fresh site_unlock request with a message", !r5.error && !!r5.data, r5.error?.message);
    const r5Id = r5.data?.id;

    if (r5Id) {
      const immutableAttempts = [
        { column: "kind", update: { kind: "session_end" } },
        { column: "requester_user_id", update: { requester_user_id: userD.id } },
        { column: "friend_user_id", update: { friend_user_id: userB.id } },
        { column: "hostname", update: { hostname: "evil.com" } },
        { column: "session_id", update: { session_id: "a-different-session" } },
        { column: "message", update: { message: "tampered message" } },
      ];
      for (const { column, update } of immutableAttempts) {
        // Paired with a legitimate status/resolved_by change (self-resolve, allowed by RLS for
        // this requester/kind per Decision 4) so a plain RLS WITH CHECK rejection can't be
        // mistaken for the trigger doing its job - isolates the trigger as the thing under test.
        await expectDenied(
          `Case 5: a direct UPDATE changing "${column}" (alongside an otherwise-legitimate resolve) is rejected by the immutable-columns trigger`,
          () =>
            clientA
              .from("friend_requests")
              .update({ status: "denied", resolved_at: new Date().toISOString(), resolved_by: userA.id, ...update })
              .eq("id", r5Id)
              .select()
              .single()
        );
      }

      const { data: r5AfterAttempts } = await admin
        .from("friend_requests")
        .select("kind, requester_user_id, friend_user_id, hostname, session_id, message, status")
        .eq("id", r5Id)
        .single();
      record(
        "Case 5: the row's identity/context columns are still exactly what they were created with",
        r5AfterAttempts?.kind === "site_unlock" &&
          r5AfterAttempts?.requester_user_id === userA.id &&
          r5AfterAttempts?.friend_user_id === null &&
          r5AfterAttempts?.hostname === "reddit.com" &&
          r5AfterAttempts?.session_id === sessionId &&
          r5AfterAttempts?.message === "original message" &&
          r5AfterAttempts?.status === "pending",
        `got ${JSON.stringify(r5AfterAttempts)}`
      );

      // A legitimate resolve (status/resolved_at/resolved_by/expires_at ONLY) on this same row
      // still succeeds - the trigger isn't blocking resolution itself, only the identity columns.
      await expectOk(
        "Case 5: a legitimate resolve (status/resolved_at/resolved_by only, no identity columns touched) on the same row still succeeds",
        () => resolveRequestAs(clientA, r5Id, "denied", userA.id)
      );
    }

    // === Case 6: the three dropped tables are genuinely gone ===
    console.log("\n=== Case 6: unlock_requests/temp_passcode_requests/session_end_requests no longer exist ===");
    for (const table of ["unlock_requests", "temp_passcode_requests", "session_end_requests"]) {
      // service_role bypasses RLS entirely, so a failure here proves the relation itself is gone,
      // not merely newly inaccessible to this role.
      const { error } = await admin.from(table).select("*").limit(1);
      record(
        `Case 6: "select * from ${table}" fails with a relation-does-not-exist error (service-role, bypasses RLS)`,
        !!error && /does not exist|could not find the table|schema cache/i.test(error.message ?? ""),
        error ? error.message : "NOT denied - the table still exists"
      );
    }
  } finally {
    await cleanup(userIds);
    await confirmNoLeftovers(userIds, emails);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Friend requests verification summary ===");
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
  console.error("verify-friend-requests.mjs crashed:", err);
  process.exit(1);
});
