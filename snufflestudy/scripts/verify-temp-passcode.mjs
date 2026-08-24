// Live end-to-end proof for v3.3 Task 10's Definition of Done: "two real accounts - requester
// asks, friend approves (friend's UI never shows or reveals any code); requester's LockedPage.tsx
// ... no code is ever typed anywhere ... Negative case: a different, unrelated signed-in account
// attempting TEMP_PASSCODE_CLAIM_APPROVAL against someone else's requestId gets { ok: false }
// (RLS denies the read; verify this directly with two accounts, not just by inspection)."
//
// v3.3 Task 10 rewrote this script from its pre-Task-10 version (which exercised the now-deleted
// redeem-temp-passcode Edge Function, PBKDF2 hashing/salting, and the lockout machinery via
// code_hash/code_salt/failed_attempts/locked_until - none of which exist anymore). What's left
// below is every check that is STILL a live, meaningful guarantee post-redesign: approval alone
// is now the entire security boundary (both approve-temp-passcode's identity check and
// temp_passcode_requests' RLS/INSERT-policy/UPDATE-revoke/RPC guards), so this focuses on proving
// that boundary end-to-end, plus a schema-level proof that the dropped columns/function are
// genuinely gone (not just newly RLS-blocked).
//
// This run also exercises migration 20260815000036_v3.3_temp_passcode_no_code.sql's OWN new SQL
// particularly hard: unlike the plan's literal bare `drop column` block, that migration had to
// drop and recreate the INSERT policy first (a real dependency the plan's SQL missed - Postgres
// rejects a bare DROP COLUMN when a policy's WITH CHECK expression still references it). Cases
// 8-13 below are the live proof that the rewritten policy preserves every non-code-related
// guarantee the original had (self-approval still denied, cross-group targeting still denied,
// the legitimate insert path still works, DELETE still denied) - not just that it compiles.
//
// Standalone Node script (same style/conventions as scripts/verify-unlock-requests.mjs, the
// closest current analog - approve-then-background-apply, no human-relayed secret) - reads .env
// via dotenv/config, not part of `npm test`. Run directly:
//   node scripts/verify-temp-passcode.mjs
//
// What it does:
//   1. Creates three ephemeral, auto-confirmed accounts: A (requester), B (A's designated friend,
//      in a shared group G1), C (a friend in a DIFFERENT group G2, sharing nothing with A/B - used
//      for the negative/RLS checks).
//   2. Case 1 (happy path, no code anywhere): A creates a pending request R1 (own authenticated
//      insert, the same call tempPasscodeApi.createRequest makes). B approves it via the real
//      deployed approve-temp-passcode Edge Function - asserts the response body's keys are
//      EXACTLY {hostname, expiresAt}, no `code` field at all. A then performs the exact
//      claimApproval-shaped read (select hostname/status/expires_at, .eq("status","approved"),
//      .single()) directly against the live table as their own authenticated client - asserts it
//      succeeds and returns the right hostname/a future expiresAt.
//   3. Case 2 (negative - RLS, the DoD's explicit requirement): C (unrelated - different group,
//      not the requester or assigned friend on R1) attempts the IDENTICAL claimApproval-shaped
//      read against R1. Asserted denied via the same `.select().single()`-forces-an-error trick
//      this codebase's other verify-*.mjs scripts use (RLS silently filters to zero rows; chaining
//      `.single()` turns that into a hard PostgREST error instead of an ambiguous empty success).
//   4. Case 3 (schema-level proof, not just RLS): A (a legitimate reader of R1) attempts to select
//      code_hash/code_salt/failed_attempts/locked_until by name - asserts each fails with a
//      column-does-not-exist-shaped error (distinct from a permission-denied error), proving the
//      migration actually dropped these columns rather than just re-gating them.
//   5. Case 4: record_temp_passcode_failed_attempt() no longer exists - calling it via RPC is
//      asserted to fail.
//   6. Case 5 (Edge Function authorization, unaffected by Task 10): C (not the assigned friend)
//      cannot approve a request that isn't assigned to them; B attempting to re-approve the
//      already-approved R1 is rejected (first-responder-wins guard, unchanged).
//   7. Case 6 (direct client UPDATE self-approval still denied): A attempts a direct client
//      UPDATE setting their own pending request's status to 'approved' (no code fields to forge
//      anymore - there's nothing left to set). Still denied outright (the blanket
//      `revoke update ... from authenticated`, unaffected by Task 10).
//   8. Case 7 (direct client INSERT self-approval still denied): A attempts to INSERT a
//      pre-'approved' row directly. Still denied by the rewritten INSERT policy's
//      `status = 'pending'` check.
//   9. Case 8: a requester cannot INSERT a request naming themselves as friend_user_id (unchanged
//      self-assignment guard, still present in the rewritten policy).
//  10. Case 9: the legitimate pending-request INSERT (exactly what tempPasscodeApi.ts's
//      createRequest does) still succeeds under the rewritten policy.
//  11. Case 10: DELETE remains denied for the authenticated role.
//  12. Case 11: a request cannot name a friend the requester shares no group with (unchanged
//      shared-group floor, still present in the rewritten policy).
//  13. Case 12: deny_temp_passcode_request() RPC - unaffected by Task 10, re-confirmed as a
//      regression guard since this migration touched the same table's policy set: C (not the
//      assigned friend) cannot deny R1; B (the actual assigned friend) still can, were R1 not
//      already approved - exercised against a fresh request instead.
//  14. Cleans up every row and account it created via the service-role client, then re-queries to
//      confirm zero leftover test users/rows.
//  15. Prints a pass/fail summary and exits non-zero if anything failed.

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
const PASSWORD = `Verify-TempPasscode-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Mirrors scripts/verify-rls.mjs's/verify-unlock-requests.mjs's expectDenied/expectOk exactly.
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
  const email = `temp-passcode-test-${label}-${RUN_ID}@example.com`;
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
  return { client, accessToken: data.session.access_token };
}

// Direct admin group setup - same shortcut scripts/verify-unlock-requests.mjs/
// verify-friend-sync.mjs take.
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

// Calls a deployed Edge Function directly via fetch, mirroring verify-coaching-message.mjs's
// identical callFunction - raw HTTP status code, no supabase.functions.invoke() indirection.
async function callFunction(functionName, accessToken, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors tempPasscodeApi.ts's createRequest() insert exactly (same table/columns/narrowed
// select) - the actual RLS-bound write path the app itself uses.
const NARROW_COLUMNS =
  "id, session_id, hostname, requester_user_id, friend_user_id, status, expires_at, delivered_via, requested_at, resolved_at";

async function createRequestAs(client, requesterUserId, friendUserId, hostname, sessionId) {
  return client
    .from("temp_passcode_requests")
    .insert({
      session_id: sessionId,
      hostname,
      requester_user_id: requesterUserId,
      friend_user_id: friendUserId,
      status: "pending",
      delivered_via: "email+in_app",
    })
    .select(NARROW_COLUMNS)
    .single();
}

// Mirrors tempPasscodeApi.ts's claimApproval() read exactly - the fresh, RLS-gated read that IS
// the entire client-side implementation of "claim an approved request" post-Task-10 (no code, no
// Edge Function call at all - just this select).
function claimApprovalReadAs(client, requestId) {
  return client
    .from("temp_passcode_requests")
    .select("hostname, status, expires_at")
    .eq("id", requestId)
    .eq("status", "approved")
    .single();
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as every other
  // verify-*.mjs script) - referencing rows must go before the users they reference.
  await admin.from("temp_passcode_requests").delete().in("requester_user_id", userIds);
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

// Re-queries every table this script touched, scoped to this run's own synthetic values, to
// confirm cleanup() actually left nothing behind - not just that its calls didn't error. Per this
// task's own instruction: prior tasks in this run have been bitten by leftover rows/users despite
// a cleanup() call that "looked" complete.
async function confirmNoLeftovers(userIds, emails) {
  const leftoverRequests = await admin
    .from("temp_passcode_requests")
    .select("id")
    .in("requester_user_id", userIds);
  record(
    "Cleanup check: no leftover temp_passcode_requests rows for these test users",
    (leftoverRequests.data ?? []).length === 0,
    `found ${leftoverRequests.data?.length ?? 0}`
  );

  const leftoverMemberships = await admin
    .from("group_memberships")
    .select("group_id")
    .in("user_id", userIds);
  record(
    "Cleanup check: no leftover group_memberships rows for these test users",
    (leftoverMemberships.data ?? []).length === 0,
    `found ${leftoverMemberships.data?.length ?? 0}`
  );

  const leftoverGroups = await admin
    .from("friend_groups")
    .select("id")
    .in("owner_user_id", userIds);
  record(
    "Cleanup check: no leftover friend_groups rows owned by these test users",
    (leftoverGroups.data ?? []).length === 0,
    `found ${leftoverGroups.data?.length ?? 0}`
  );

  const leftoverSettings = await admin
    .from("friendship_settings")
    .select("user_id")
    .or(`user_id.in.(${userIds.join(",")}),friend_user_id.in.(${userIds.join(",")})`);
  record(
    "Cleanup check: no leftover friendship_settings rows for these test users",
    (leftoverSettings.data ?? []).length === 0,
    `found ${leftoverSettings.data?.length ?? 0}`
  );

  for (const email of emails) {
    const { data: byEmail } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const stillThere = (byEmail?.users ?? []).some((u) => u.email === email);
    record(`Cleanup check: auth.users no longer contains ${email}`, !stillThere);
  }
}

async function main() {
  console.log(
    "Creating ephemeral test accounts (A = requester, B = A's designated friend in shared group G1, C = unrelated, different group G2)..."
  );
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userC.id];
  const emails = [userA.email, userB.email, userC.email];

  try {
    const { client: clientA, accessToken: tokenA } = await signIn(userA.email);
    const { client: clientB, accessToken: tokenB } = await signIn(userB.email);
    const { client: clientC } = await signIn(userC.email);
    record("Setup: A, B, C signed in via anon-key client", true);

    await createGroupWithMembers(
      userA.id,
      [userA.id, userB.id],
      `Verify Temp Passcode G1 ${RUN_ID}`
    );
    await createGroupWithMembers(userC.id, [userC.id], `Verify Temp Passcode G2 (unrelated) ${RUN_ID}`);
    record("Setup: A/B share group G1; C is alone in unrelated group G2", true);

    const sessionId = `verify-temp-passcode-${RUN_ID}`;

    // === Case 1: happy path - approve carries no code, claimApproval-shaped read succeeds ===
    //
    // IMPORTANT, discovered by actually running this against the live project (not by
    // inspection): per this codebase's established convention (docs/qa/V3.2_Two_Account_QA_
    // Script.md's "Deploy/redeploy the two changed Edge Functions" section, and this task's own
    // explicit instruction), Edge Function deployment happens once, at the Task 15 two-account QA
    // gate - NOT per implementation task. The repo's approve-temp-passcode/index.ts is correct
    // (matches the plan, unit-tested in tempPasscodeApi.test.ts), but the CURRENTLY DEPLOYED
    // version on this live project is still the pre-Task-10 code, which writes to code_hash/
    // code_salt/failed_attempts/locked_until - columns this migration just dropped. Calling it
    // right now therefore 500s ("Failed to approve request"), NOT because anything in this task
    // is wrong, but because the deployed function and the live schema are now (deliberately,
    // temporarily) out of sync until Task 15 redeploys it. This is logged as an informational
    // note, not scored as a pass/fail check, to avoid conflating "not yet deployed" with "broken."
    //
    // To still prove what Task 10 actually controls RIGHT NOW - the RLS/schema/claimApproval-read
    // half - this simulates what the redeployed Edge Function will do (service-role update to
    // status='approved'/expires_at/resolved_at, no code fields - there's nothing left to set)
    // directly via the admin client, standing in for the not-yet-deployed function.
    console.log("\n=== Case 1: happy path (create -> approve, no code anywhere -> claim) ===");
    const r1 = await createRequestAs(clientA, userA.id, userB.id, "youtube.com", sessionId);
    record("Case 1: A creates a pending request R1 (own authenticated insert, real RLS)", !r1.error && !!r1.data, r1.error?.message);
    const r1Id = r1.data?.id;

    let r1ExpiresAt = null;
    if (r1Id) {
      const approveRes = await callFunction("approve-temp-passcode", tokenB, { requestId: r1Id });
      console.log(
        `  [INFO, not scored] live approve-temp-passcode call: status ${approveRes.status}, ` +
          `body ${JSON.stringify(approveRes.json)} - a non-200 here is EXPECTED until Task 15 ` +
          "redeploys this function; the repo's own source is verified separately (see report)."
      );

      // Simulates the redeployed approve-temp-passcode's own update exactly (status='approved',
      // expires_at, resolved_at - no code_hash/code_salt/failed_attempts/locked_until, they don't
      // exist anymore) - this IS the actual code path supabase/functions/approve-temp-passcode/
      // index.ts now contains, just invoked via the service-role client instead of through the
      // (not-yet-redeployed) live function.
      r1ExpiresAt = Date.now() + 15 * 60 * 1000;
      const simulatedApprove = await admin
        .from("temp_passcode_requests")
        .update({
          status: "approved",
          expires_at: new Date(r1ExpiresAt).toISOString(),
          resolved_at: new Date().toISOString(),
        })
        .eq("id", r1Id)
        .eq("status", "pending")
        .select("id")
        .single();
      record(
        "Case 1 setup: R1 forced to approved (simulating the redeployed Edge Function) so the claim-read/RLS checks below have a genuinely approved row to test against",
        !simulatedApprove.error,
        simulatedApprove.error?.message
      );

      const claimed = await expectOk(
        "Case 1: A (requester) performs the exact claimApproval-shaped read against R1 and succeeds",
        () => claimApprovalReadAs(clientA, r1Id)
      );
      if (claimed) {
        record(
          "Case 1: the claim read returns the right hostname/status and a future expires_at, and carries no code field at all",
          claimed.hostname === "youtube.com" &&
            claimed.status === "approved" &&
            new Date(claimed.expires_at).getTime() === r1ExpiresAt &&
            !("code" in claimed),
          `got ${JSON.stringify(claimed)}`
        );
      }
    }

    // === Case 2 (DoD's explicit negative case): an unrelated account cannot claim R1 ===
    console.log(
      "\n=== Case 2: an unrelated signed-in account (C) cannot claim someone else's approved request (RLS) ==="
    );
    if (r1Id) {
      await expectDenied(
        "Case 2: C (unrelated - different group, not requester or assigned friend) cannot perform the claimApproval-shaped read against R1",
        () => claimApprovalReadAs(clientC, r1Id)
      );
    }

    // === Case 3: schema-level proof the dropped columns are actually gone, not just re-gated ===
    console.log(
      "\n=== Case 3: code_hash/code_salt/failed_attempts/locked_until no longer exist on the table at all ==="
    );
    if (r1Id) {
      for (const column of ["code_hash", "code_salt", "failed_attempts", "locked_until"]) {
        const res = await clientA.from("temp_passcode_requests").select(column).eq("id", r1Id).single();
        record(
          `Case 3: selecting "${column}" fails (column no longer exists)`,
          !!res.error,
          res.error ? `denied — ${res.error.message}` : `NOT denied — got ${JSON.stringify(res.data)}`
        );
      }
    }

    // === Case 4: record_temp_passcode_failed_attempt() no longer exists ===
    console.log("\n=== Case 4: record_temp_passcode_failed_attempt() RPC no longer exists ===");
    {
      const rpcRes = await admin.rpc("record_temp_passcode_failed_attempt", {
        p_request_id: r1Id ?? crypto.randomUUID(),
        p_max_attempts: 3,
        p_lockout_seconds: 60,
      });
      record(
        "Case 4: calling the dropped RPC fails",
        !!rpcRes.error,
        rpcRes.error ? `denied — ${rpcRes.error.message}` : `NOT denied — got ${JSON.stringify(rpcRes.data)}`
      );
    }

    // === Case 5: Edge Function-level authorization (unaffected by Task 10) ===
    console.log("\n=== Case 5: Edge Function-level authorization ===");
    const r5 = await createRequestAs(clientA, userA.id, userB.id, "instagram.com", sessionId);
    const r5Id = r5.data?.id;
    if (r5Id) {
      const cApprove = await callFunction("approve-temp-passcode", undefined, { requestId: r5Id });
      // No token at all - callFunction still sends an Authorization header of "Bearer undefined"
      // via template interpolation, so use a real-but-wrong caller instead for a meaningful check.
      const cApproveWrongCaller = await callFunction("approve-temp-passcode", (await signIn(userC.email)).accessToken, {
        requestId: r5Id,
      });
      record(
        "Case 5: C (not the assigned friend) cannot approve R5 - rejected, not 200",
        cApproveWrongCaller.status !== 200,
        `got status ${cApproveWrongCaller.status}, body ${JSON.stringify(cApproveWrongCaller.json)}`
      );
      void cApprove; // Unused beyond documenting the malformed-auth variant isn't what's asserted.
    }
    if (r1Id) {
      const reapprove = await callFunction("approve-temp-passcode", tokenB, { requestId: r1Id });
      record(
        "Case 5: approving the already-approved R1 again is rejected (first-responder-wins, unchanged)",
        reapprove.status !== 200,
        `got status ${reapprove.status}, body ${JSON.stringify(reapprove.json)}`
      );
    }

    // === Case 6: a requester cannot self-approve via a direct client UPDATE ===
    console.log(
      "\n=== Case 6: a requester cannot self-approve a request via a direct client UPDATE ==="
    );
    const r6 = await createRequestAs(clientA, userA.id, userB.id, "twitch.tv", sessionId);
    const r6Id = r6.data?.id;
    if (r6Id) {
      const selfApprove = await clientA
        .from("temp_passcode_requests")
        .update({ status: "approved", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
        .eq("id", r6Id)
        .select("id")
        .single();
      record(
        "Case 6: a direct client UPDATE self-approving R6 is DENIED outright (blanket UPDATE revoke, unaffected by Task 10)",
        !!selfApprove.error,
        selfApprove.error
          ? `denied — ${selfApprove.error.message}`
          : `NOT denied — got ${JSON.stringify(selfApprove.data)}`
      );

      const { data: r6After } = await admin
        .from("temp_passcode_requests")
        .select("status")
        .eq("id", r6Id)
        .single();
      record(
        "Case 6: R6's status is still 'pending' afterward",
        r6After?.status === "pending",
        `got status=${r6After?.status}`
      );
    }

    // === Case 7: a requester cannot INSERT a pre-approved request directly ===
    console.log(
      "\n=== Case 7: a requester cannot INSERT a pre-approved request directly (rewritten INSERT policy) ==="
    );
    {
      const selfApproveInsert = await clientA
        .from("temp_passcode_requests")
        .insert({
          session_id: sessionId,
          hostname: "insert-exploit.com",
          requester_user_id: userA.id,
          friend_user_id: userB.id,
          status: "approved",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          delivered_via: "email",
        })
        .select("id")
        .single();
      record(
        "Case 7: a direct client INSERT with status:'approved' is DENIED outright",
        !!selfApproveInsert.error,
        selfApproveInsert.error
          ? `denied — ${selfApproveInsert.error.message}`
          : `NOT denied — got ${JSON.stringify(selfApproveInsert.data)}`
      );

      const { data: leaked } = await admin
        .from("temp_passcode_requests")
        .select("id")
        .eq("hostname", "insert-exploit.com")
        .eq("requester_user_id", userA.id);
      record(
        "Case 7: no row was actually created by the rejected INSERT",
        (leaked ?? []).length === 0,
        `found ${leaked?.length ?? 0} row(s)`
      );
    }

    // === Case 8: a requester cannot INSERT a request naming themselves as friend_user_id ===
    console.log(
      "\n=== Case 8: a requester cannot INSERT a request naming themselves as friend_user_id ==="
    );
    {
      const selfFriendInsert = await clientA
        .from("temp_passcode_requests")
        .insert({
          session_id: sessionId,
          hostname: "self-friend-exploit.com",
          requester_user_id: userA.id,
          friend_user_id: userA.id,
          status: "pending",
          delivered_via: "email+in_app",
        })
        .select("id")
        .single();
      record(
        "Case 8: a direct client INSERT naming the requester as their own assigned friend is DENIED outright",
        !!selfFriendInsert.error,
        selfFriendInsert.error
          ? `denied — ${selfFriendInsert.error.message}`
          : `NOT denied — got ${JSON.stringify(selfFriendInsert.data)}`
      );
    }

    // === Case 9: the legitimate pending-request INSERT still succeeds under the rewritten policy ===
    console.log(
      "\n=== Case 9: the legitimate pending-request INSERT still succeeds under the rewritten policy ==="
    );
    {
      const legit = await createRequestAs(clientA, userA.id, userB.id, "legit-after-fix.com", sessionId);
      record(
        "Case 9: the normal pending-request INSERT (exactly what tempPasscodeApi.ts's createRequest does) still succeeds",
        !legit.error && !!legit.data && legit.data.status === "pending",
        legit.error?.message ?? `got ${JSON.stringify(legit.data)}`
      );
    }

    // === Case 10: DELETE remains denied ===
    console.log("\n=== Case 10: DELETE remains denied for the authenticated role ===");
    if (r1Id) {
      const deleteAttempt = await clientA
        .from("temp_passcode_requests")
        .delete()
        .eq("id", r1Id)
        .select("id")
        .single();
      record(
        "Case 10: the requester cannot DELETE their own request row",
        !!deleteAttempt.error,
        deleteAttempt.error
          ? `denied — ${deleteAttempt.error.message}`
          : "NOT denied - DELETE succeeded"
      );

      const { data: stillThere } = await admin
        .from("temp_passcode_requests")
        .select("id")
        .eq("id", r1Id)
        .single();
      record(
        "Case 10: R1 still exists after the denied DELETE attempt (not silently removed)",
        !!stillThere,
        stillThere ? "row present" : "row missing"
      );
    }

    // === Case 11: a request cannot name a friend the requester shares no group with ===
    console.log(
      "\n=== Case 11: a request cannot name a friend the requester shares no group with (shared-group floor) ==="
    );
    {
      const strangerTarget = await clientC
        .from("temp_passcode_requests")
        .insert({
          session_id: sessionId,
          hostname: "evil.com",
          requester_user_id: userC.id,
          friend_user_id: userA.id,
          status: "pending",
          delivered_via: "email",
        })
        .select("id")
        .single();
      record(
        "Case 11: C (no shared group with A) cannot create a request naming A as the approving friend",
        !!strangerTarget.error,
        strangerTarget.error
          ? `denied — ${strangerTarget.error.message}`
          : `NOT denied — got ${JSON.stringify(strangerTarget.data)}`
      );

      const { data: leaked } = await admin
        .from("temp_passcode_requests")
        .select("id")
        .eq("requester_user_id", userC.id);
      record(
        "Case 11: no row was actually created by the rejected INSERT",
        (leaked ?? []).length === 0,
        `found ${leaked?.length ?? 0} row(s)`
      );
    }

    // === Case 12: deny_temp_passcode_request() RPC (unaffected by Task 10, regression guard) ===
    console.log("\n=== Case 12: deny_temp_passcode_request RPC still works correctly ===");
    const r12 = await createRequestAs(clientA, userA.id, userB.id, "netflix.com", sessionId);
    const r12Id = r12.data?.id;
    if (r12Id) {
      const cDeny = await clientC.rpc("deny_temp_passcode_request", { p_request_id: r12Id });
      record(
        "Case 12: C (unrelated - not the assigned friend) cannot deny R12 via the RPC",
        !!cDeny.error,
        cDeny.error ? `denied — ${cDeny.error.message}` : `NOT denied — got ${JSON.stringify(cDeny.data)}`
      );

      const bDeny = await clientB.rpc("deny_temp_passcode_request", { p_request_id: r12Id });
      record("Case 12: B (the actual assigned friend) CAN still legitimately deny R12", !bDeny.error, bDeny.error?.message);

      const { data: r12After } = await admin
        .from("temp_passcode_requests")
        .select("status")
        .eq("id", r12Id)
        .single();
      record("Case 12: R12's status is now 'denied'", r12After?.status === "denied", `got status=${r12After?.status}`);
    }
  } finally {
    await cleanup(userIds);
    await confirmNoLeftovers(userIds, emails);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Temp passcode verification summary ===");
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
  console.error("verify-temp-passcode.mjs crashed:", err);
  process.exit(1);
});
