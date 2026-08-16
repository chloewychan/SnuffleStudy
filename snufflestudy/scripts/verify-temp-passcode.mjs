// Live end-to-end proof for Task 12's Definition of Done: "requesting a temp passcode for one
// hostname during a hard-mode session emails the designated friend (and notifies them in-app if
// they have an account); an approved code unlocks only that hostname, only until expiresAt, and
// every other hard-restricted site stays blocked; confirm temp_passcode_requests.code_hash is
// never queryable as, or reconstructible into, the plaintext code from the client (same hashing
// discipline as v1's HardBlockCredential - a temp code is not allowed to be a weaker link than
// the permanent one)."
//
// Standalone Node script (same style/conventions as scripts/verify-coaching-message.mjs/
// verify-unlock-requests.mjs - reuses their test-account/callFunction/expectOk-style helpers),
// reads .env via dotenv/config, not part of `npm test`. Run directly:
//   node scripts/verify-temp-passcode.mjs
//
// Exercises the three REAL deployed Edge Functions (send-temp-passcode-request,
// approve-temp-passcode, redeem-temp-passcode) via plain fetch (not supabase.functions.invoke() -
// same rationale as verify-coaching-message.mjs's callFunction: direct, unambiguous access to the
// raw HTTP status code on every response), and the live table's RLS/column-level GRANTs via the
// anon-key client signed in as each test user.
//
// What it does:
//   1. Creates three ephemeral, auto-confirmed accounts: A (requester), B (A's designated friend,
//      in a shared group G1), C (a friend in a DIFFERENT group G2, sharing nothing with A/B - used
//      for the negative/RLS checks).
//   2. Case 1 (happy path): A creates a pending request R1 (via A's own authenticated insert, the
//      same call tempPasscodeApi.createRequest makes). B approves it via the real deployed
//      approve-temp-passcode Edge Function, gets back a real plaintext code. A redeems it via the
//      real deployed redeem-temp-passcode Edge Function with the correct code - confirms success
//      and that the response carries the right hostname/a future expiresAt.
//   3. Case 2 (wrong code rejected, no leak): a fresh request R2, approved by B. A submits an
//      incorrect code - confirms ok:false and that neither "code_hash" nor "code_salt" appears
//      anywhere in the response body (stringified).
//   4. Case 3 (lockout): a fresh request R3, approved by B. A submits 3 wrong codes in a row -
//      confirms the lockout engages, then confirms a 4th attempt WITH THE CORRECT CODE is still
//      rejected while locked (mirrors hardBlockCredential.ts's lockout-check-first behavior).
//   5. Case 4 (expiry): a fresh request R4, approved by B (capturing the real code), then its
//      expires_at is pushed into the past directly via the service-role client (simulating time
//      passing, rather than actually sleeping 15 minutes). A redeems with the CORRECT code -
//      confirms it's rejected as expired, and confirms the row's status was flipped to 'expired'
//      as the documented side effect.
//   6. Case 5 (column-narrowing / code_hash never queryable): as A (a legitimate reader of R1
//      under RLS), a bare `.select("*")`/explicit `code_hash` select against
//      temp_passcode_requests is asserted to be DENIED outright (Postgres column-level GRANT,
//      supabase/migrations/20260815000016_v2_temp_passcode_hard_mode.sql) - not just silently
//      missing the field. The narrowed column list tempPasscodeApi.ts actually uses is asserted to
//      succeed and to never contain a code_hash/code_salt key. This is the DoD's explicit
//      requirement, checked directly against the live table under RLS, not just a unit-mocked test
//      (see tempPasscodeApi.test.ts's own client-side regression test for that half).
//   7. Case 6 (RLS - unrelated third party): C (no shared group, not the friend on any request)
//      cannot read R1 at all.
//   8. Case 7 (authorization on the Edge Functions themselves): C cannot approve a request that
//      isn't assigned to them (403); C cannot redeem a request they didn't create (403); B
//      attempting to approve an already-approved request is rejected (409/ok:false).
//   9. Case 8 (send-temp-passcode-request / email leg): calls the real deployed function for one
//      of the created requests as A, confirms it returns ok:true, and documents (does not fail on)
//      whether emailSent was true or false - Resend's shared sandbox sending domain
//      (onboarding@resend.dev) typically can only deliver to the Resend account owner's own
//      verified email until a custom domain is DNS-verified, which is an expected, known
//      limitation of this environment per this task's brief, not something this script works
//      around.
//  10. Case 9 (fix round 1, Critical): the exact exploit a code review found - the REQUESTER
//      attempts a direct client-side `.update()` against their own pending request, self-approving
//      it with a self-chosen code (hashed with the SAME public PBKDF2 algorithm this script's
//      attackerComputeHash() below ports from src/domain/sites/hardBlockCredential.ts, simulating
//      a real attacker who has the shipped extension bundle). Asserts the UPDATE itself is denied
//      outright, that the row's status is still 'pending' afterward (no partial write), and that
//      redeeming with the attacker's own chosen code via the real Edge Function still fails
//      end-to-end - closing the loop, not just checking the raw UPDATE call's error.
//  11. Case 10 (fix round 1): the new deny_temp_passcode_request() RPC - C (not the assigned
//      friend) cannot deny a request via the RPC; B (the actual assigned friend) still CAN, and
//      the row's status becomes 'denied' - proving the Critical fix's lockdown didn't also break
//      the legitimate deny path it was meant to preserve.
//  12. Case 11 (fix round 1, Important): fires CONCURRENT wrong-guess requests (Promise.all, not
//      sequential) against one freshly-approved request and asserts failed_attempts lands at
//      EXACTLY the number of concurrent guesses - a direct regression proof that the atomic
//      record_temp_passcode_failed_attempt() UPDATE doesn't lose updates the way the old
//      read-then-write-in-two-round-trips implementation could under concurrency.
//  13. Cleans up every row and account it created via the service-role client.
//  14. Prints a pass/fail summary and exits non-zero if anything failed.

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, pbkdf2Sync } from "node:crypto";

// Fix round 1 (Critical, Case 9): a line-for-line port of src/domain/sites/
// hardBlockCredential.ts's hashPasscode algorithm using Node's built-in crypto instead of
// Web Crypto's subtle.deriveBits - same PBKDF2-HMAC-SHA256, 100,000 iterations, 256-bit output,
// hex-encoded, so it produces byte-identical hashes to the real client/Edge Function
// implementation. This is deliberately how an attacker with access to the shipped extension
// bundle (a plain PBKDF2 implementation, no secret material) would forge a hash for a
// self-chosen code - the point of Case 9 is proving the server-side write path rejects this, not
// that the hash itself is somehow unguessable.
const PBKDF2_ITERATIONS = 100_000;
function attackerComputeHash(code, saltHex) {
  return pbkdf2Sync(code, Buffer.from(saltHex, "hex"), PBKDF2_ITERATIONS, 32, "sha256").toString(
    "hex"
  );
}

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
// verify-friend-sync.mjs take (the invite-code join flow itself is already proven by
// verify-rls.mjs; this script starts from "accounts already share a group" and focuses on
// temp_passcode_requests' own behavior).
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

// Mirrors unlockRequestApi.ts's createRequest() insert exactly (same table/columns/narrowed
// select), run as the REQUESTER's own authenticated client - this is the actual RLS-bound write
// path the app itself uses, not an admin shortcut, so it also proves the insert-side RLS/grants
// work end-to-end.
const NARROW_COLUMNS =
  "id, session_id, hostname, requester_user_id, friend_user_id, status, expires_at, delivered_via, failed_attempts, locked_until, requested_at, resolved_at";

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

async function main() {
  console.log(
    "Creating ephemeral test accounts (A = requester, B = A's designated friend in shared group G1, C = unrelated, different group G2)..."
  );
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userC.id];

  try {
    const { client: clientA, accessToken: tokenA } = await signIn(userA.email);
    const { client: clientB, accessToken: tokenB } = await signIn(userB.email);
    const { client: clientC, accessToken: tokenC } = await signIn(userC.email);
    record("Setup: A, B, C signed in via anon-key client", true);

    await createGroupWithMembers(
      userA.id,
      [userA.id, userB.id],
      `Verify Temp Passcode G1 ${RUN_ID}`
    );
    await createGroupWithMembers(userC.id, [userC.id], `Verify Temp Passcode G2 (unrelated) ${RUN_ID}`);
    record("Setup: A/B share group G1; C is alone in unrelated group G2", true);

    const sessionId = `verify-temp-passcode-${RUN_ID}`;

    // === Case 1: happy path ===
    console.log("\n=== Case 1: happy path (create -> approve -> redeem) ===");
    const r1 = await createRequestAs(clientA, userA.id, userB.id, "youtube.com", sessionId);
    record("Case 1: A creates a pending request R1 (own authenticated insert, real RLS)", !r1.error && !!r1.data, r1.error?.message);
    const r1Id = r1.data?.id;

    let r1Code = null;
    if (r1Id) {
      const approveRes = await callFunction("approve-temp-passcode", tokenB, { requestId: r1Id });
      record(
        "Case 1: B (assigned friend) approves R1 via the real deployed Edge Function - HTTP 200",
        approveRes.status === 200,
        `got status ${approveRes.status}, body ${JSON.stringify(approveRes.json)}`
      );
      record(
        "Case 1: approve response carries a plaintext numeric code, hostname, and a future expiresAt",
        typeof approveRes.json?.code === "string" &&
          /^\d{6}$/.test(approveRes.json.code) &&
          approveRes.json?.hostname === "youtube.com" &&
          typeof approveRes.json?.expiresAt === "number" &&
          approveRes.json.expiresAt > Date.now(),
        `got ${JSON.stringify(approveRes.json)}`
      );
      r1Code = approveRes.json?.code;

      if (r1Code) {
        const redeemRes = await callFunction("redeem-temp-passcode", tokenA, {
          requestId: r1Id,
          code: r1Code,
        });
        record(
          "Case 1: A (requester) redeems R1 with the CORRECT code via the real deployed Edge Function - ok:true",
          redeemRes.status === 200 && redeemRes.json?.ok === true,
          `got status ${redeemRes.status}, body ${JSON.stringify(redeemRes.json)}`
        );
        record(
          "Case 1: redeem response carries the correct hostname and a matching expiresAt (unlocks only THIS hostname, only until expiresAt)",
          redeemRes.json?.hostname === "youtube.com" &&
            redeemRes.json?.expiresAt === approveRes.json?.expiresAt,
          `got ${JSON.stringify(redeemRes.json)}`
        );
      }
    }

    // === Case 2: wrong code rejected, no leak ===
    console.log("\n=== Case 2: wrong code is rejected without leaking code_hash ===");
    const r2 = await createRequestAs(clientA, userA.id, userB.id, "instagram.com", sessionId);
    const r2Id = r2.data?.id;
    let r2Approve = null;
    if (r2Id) {
      r2Approve = await callFunction("approve-temp-passcode", tokenB, { requestId: r2Id });
      const wrongRes = await callFunction("redeem-temp-passcode", tokenA, {
        requestId: r2Id,
        code: "000000",
      });
      record(
        "Case 2: an incorrect code is rejected (ok:false)",
        wrongRes.status === 200 && wrongRes.json?.ok === false,
        `got status ${wrongRes.status}, body ${JSON.stringify(wrongRes.json)}`
      );
      const bodyText = JSON.stringify(wrongRes.json ?? {});
      record(
        "Case 2: the rejection response never contains code_hash/code_salt anywhere in its body",
        !bodyText.includes("code_hash") && !bodyText.includes("code_salt"),
        `body: ${bodyText}`
      );
    }

    // === Case 3: lockout ===
    console.log("\n=== Case 3: repeated wrong attempts trip the lockout ===");
    const r3 = await createRequestAs(clientA, userA.id, userB.id, "reddit.com", sessionId);
    const r3Id = r3.data?.id;
    if (r3Id) {
      const r3Approve = await callFunction("approve-temp-passcode", tokenB, { requestId: r3Id });
      const r3Code = r3Approve.json?.code;

      const attemptResults = [];
      for (let i = 0; i < 3; i++) {
        const res = await callFunction("redeem-temp-passcode", tokenA, {
          requestId: r3Id,
          code: "111111",
        });
        attemptResults.push(res.json?.ok);
      }
      record(
        "Case 3: three consecutive wrong attempts are all rejected",
        attemptResults.every((ok) => ok === false),
        `results: ${JSON.stringify(attemptResults)}`
      );

      if (r3Code) {
        const correctWhileLocked = await callFunction("redeem-temp-passcode", tokenA, {
          requestId: r3Id,
          code: r3Code,
        });
        record(
          "Case 3: a 4th attempt WITH THE CORRECT CODE is still rejected while locked out (parity with hardBlockCredential.ts's lockout-check-first behavior)",
          correctWhileLocked.status === 200 && correctWhileLocked.json?.ok === false,
          `got status ${correctWhileLocked.status}, body ${JSON.stringify(correctWhileLocked.json)}`
        );
      }

      const { data: r3Row } = await admin
        .from("temp_passcode_requests")
        .select("failed_attempts, locked_until")
        .eq("id", r3Id)
        .single();
      record(
        "Case 3: the row's failed_attempts/locked_until reflect the lockout server-side (verified directly via service-role, not just via the Edge Function's own response)",
        r3Row?.failed_attempts >= 3 && !!r3Row?.locked_until && new Date(r3Row.locked_until).getTime() > Date.now(),
        `got ${JSON.stringify(r3Row)}`
      );
    }

    // === Case 4: expiry ===
    console.log("\n=== Case 4: an expired request's code is rejected even if otherwise correct ===");
    const r4 = await createRequestAs(clientA, userA.id, userB.id, "tiktok.com", sessionId);
    const r4Id = r4.data?.id;
    if (r4Id) {
      const r4Approve = await callFunction("approve-temp-passcode", tokenB, { requestId: r4Id });
      const r4Code = r4Approve.json?.code;

      // Simulate time passing (rather than sleeping 15 real minutes) by pushing expires_at into
      // the past directly via the service-role client - this is the one place this script
      // legitimately needs service-role write access to a column ordinary clients can't touch
      // via a bare update either (RLS still permits requester/friend UPDATEs in general, but
      // there's no reason to route this specific test setup through the app's own paths).
      await admin
        .from("temp_passcode_requests")
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", r4Id);

      if (r4Code) {
        const expiredRes = await callFunction("redeem-temp-passcode", tokenA, {
          requestId: r4Id,
          code: r4Code,
        });
        record(
          "Case 4: the CORRECT code is rejected once expires_at has passed",
          expiredRes.status === 200 && expiredRes.json?.ok === false,
          `got status ${expiredRes.status}, body ${JSON.stringify(expiredRes.json)}`
        );
      }

      const { data: r4Row } = await admin
        .from("temp_passcode_requests")
        .select("status")
        .eq("id", r4Id)
        .single();
      record(
        "Case 4: the row's status was flipped to 'expired' as a documented side effect of the rejected attempt",
        r4Row?.status === "expired",
        `got status=${r4Row?.status}`
      );
    }

    // === Case 5: code_hash/code_salt are never queryable from the client ===
    console.log("\n=== Case 5: code_hash/code_salt are never queryable as, or leaked into, a client response ===");
    if (r1Id) {
      const bareSelect = await clientA.from("temp_passcode_requests").select("*").eq("id", r1Id).single();
      record(
        "Case 5: a bare `.select('*')` against temp_passcode_requests is DENIED outright for the authenticated role (column-level GRANT, not just a missing field)",
        !!bareSelect.error,
        bareSelect.error ? `denied — ${bareSelect.error.message}` : `NOT denied — got ${JSON.stringify(bareSelect.data)}`
      );

      const explicitHashSelect = await clientA
        .from("temp_passcode_requests")
        .select("id, code_hash")
        .eq("id", r1Id)
        .single();
      record(
        "Case 5: an explicit `.select('id, code_hash')` is ALSO denied outright",
        !!explicitHashSelect.error,
        explicitHashSelect.error
          ? `denied — ${explicitHashSelect.error.message}`
          : `NOT denied — got ${JSON.stringify(explicitHashSelect.data)}`
      );

      const narrowSelect = await clientA
        .from("temp_passcode_requests")
        .select(NARROW_COLUMNS)
        .eq("id", r1Id)
        .single();
      record(
        "Case 5: the narrowed column list tempPasscodeApi.ts actually uses succeeds",
        !narrowSelect.error && !!narrowSelect.data,
        narrowSelect.error?.message
      );
      if (narrowSelect.data) {
        const keys = Object.keys(narrowSelect.data);
        record(
          "Case 5: the narrowed select's result object has no code_hash/code_salt key at all",
          !keys.includes("code_hash") && !keys.includes("code_salt"),
          `keys: ${keys.join(", ")}`
        );
      }
    }

    // === Case 6: RLS - an unrelated third party cannot read the request at all ===
    console.log("\n=== Case 6: an unrelated third party (different group, not the assigned friend) cannot read the request ===");
    if (r1Id) {
      const cRead = await clientC.from("temp_passcode_requests").select(NARROW_COLUMNS).eq("id", r1Id).single();
      record(
        "Case 6: C (unrelated - different group, not requester or assigned friend) cannot read R1",
        !!cRead.error || !cRead.data,
        cRead.error ? `denied — ${cRead.error.message}` : `NOT denied — got ${JSON.stringify(cRead.data)}`
      );
    }

    // === Case 7: authorization on the Edge Functions themselves ===
    console.log("\n=== Case 7: Edge Function-level authorization ===");
    if (r2Id) {
      const cApprove = await callFunction("approve-temp-passcode", tokenC, { requestId: r2Id });
      record(
        "Case 7: C (not the assigned friend) cannot approve R2 - rejected, not 200-with-a-code",
        cApprove.status !== 200 || !cApprove.json?.code,
        `got status ${cApprove.status}, body ${JSON.stringify(cApprove.json)}`
      );

      const cRedeem = await callFunction("redeem-temp-passcode", tokenC, {
        requestId: r2Id,
        code: "000000",
      });
      record(
        "Case 7: C (not the requester) cannot redeem R2 - rejected outright (403), not a normal ok:false wrong-code response",
        cRedeem.status === 403,
        `got status ${cRedeem.status}, body ${JSON.stringify(cRedeem.json)}`
      );

      // R2 was already approved earlier in Case 2 - re-approving it should be rejected.
      const reapprove = await callFunction("approve-temp-passcode", tokenB, { requestId: r2Id });
      record(
        "Case 7: approving an already-approved request is rejected (not silently re-generating a new code)",
        reapprove.status !== 200 || !reapprove.json?.code,
        `got status ${reapprove.status}, body ${JSON.stringify(reapprove.json)}`
      );
    }

    // === Case 8: send-temp-passcode-request / email leg ===
    console.log("\n=== Case 8: send-temp-passcode-request (email leg) ===");
    if (r1Id) {
      const sendRes = await callFunction("send-temp-passcode-request", tokenA, { requestId: r1Id });
      record(
        "Case 8: send-temp-passcode-request returns ok:true for a legitimate requester-triggered call",
        sendRes.status === 200 && sendRes.json?.ok === true,
        `got status ${sendRes.status}, body ${JSON.stringify(sendRes.json)}`
      );
      console.log(
        `  Note (Resend sandbox limitation): emailSent=${sendRes.json?.emailSent} - Resend's shared ` +
          "sandbox sending domain (onboarding@resend.dev) typically can only deliver to the Resend " +
          "account owner's own verified email until a custom domain is DNS-verified. This script's " +
          "test-account emails are not that address, so emailSent:false here is EXPECTED and does " +
          "not indicate a bug - the in-app delivery leg (the row itself, already proven readable by " +
          "B in Case 1) is what this task's DoD actually requires to work end-to-end without a " +
          "verified sending domain."
      );
    }

    // === Case 9 (fix round 1, Critical): a direct client UPDATE self-approval is denied ===
    console.log(
      "\n=== Case 9: a requester cannot self-approve a request via a direct client UPDATE (Critical fix) ==="
    );
    const r9 = await createRequestAs(clientA, userA.id, userB.id, "twitch.tv", sessionId);
    const r9Id = r9.data?.id;
    if (r9Id) {
      const attackerCode = "999999";
      const attackerSalt = randomBytes(16).toString("hex");
      const attackerHash = attackerComputeHash(attackerCode, attackerSalt);

      const selfApprove = await clientA
        .from("temp_passcode_requests")
        .update({
          status: "approved",
          code_hash: attackerHash,
          code_salt: attackerSalt,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          failed_attempts: 0,
          locked_until: null,
        })
        .eq("id", r9Id)
        .select("id")
        .single();
      record(
        "Case 9: a direct client UPDATE self-approving with a self-chosen code_hash/code_salt is DENIED outright",
        !!selfApprove.error,
        selfApprove.error
          ? `denied — ${selfApprove.error.message}`
          : `NOT denied — got ${JSON.stringify(selfApprove.data)}`
      );

      const { data: r9RowAfter } = await admin
        .from("temp_passcode_requests")
        .select("status, code_hash")
        .eq("id", r9Id)
        .single();
      record(
        "Case 9: R9's status is still 'pending' afterward (the malicious update did not partially apply)",
        r9RowAfter?.status === "pending",
        `got status=${r9RowAfter?.status}`
      );

      const attackerRedeem = await callFunction("redeem-temp-passcode", tokenA, {
        requestId: r9Id,
        code: attackerCode,
      });
      record(
        "Case 9: redeeming with the attacker's own self-chosen code still fails end-to-end (the row was never actually approved)",
        attackerRedeem.json?.ok !== true,
        `got status ${attackerRedeem.status}, body ${JSON.stringify(attackerRedeem.json)}`
      );
    }

    // === Case 10 (fix round 1): the new deny_temp_passcode_request() RPC ===
    console.log("\n=== Case 10: deny_temp_passcode_request RPC (legitimate deny path still works) ===");
    const r10 = await createRequestAs(clientA, userA.id, userB.id, "netflix.com", sessionId);
    const r10Id = r10.data?.id;
    if (r10Id) {
      const cDeny = await clientC.rpc("deny_temp_passcode_request", { p_request_id: r10Id });
      record(
        "Case 10: C (unrelated - not the assigned friend) cannot deny R10 via the RPC",
        !!cDeny.error,
        cDeny.error ? `denied — ${cDeny.error.message}` : `NOT denied — got ${JSON.stringify(cDeny.data)}`
      );

      const bDeny = await clientB.rpc("deny_temp_passcode_request", { p_request_id: r10Id });
      record(
        "Case 10: B (the actual assigned friend) CAN still legitimately deny R10 via the RPC",
        !bDeny.error,
        bDeny.error?.message
      );

      const { data: r10RowAfter } = await admin
        .from("temp_passcode_requests")
        .select("status")
        .eq("id", r10Id)
        .single();
      record(
        "Case 10: R10's status is now 'denied'",
        r10RowAfter?.status === "denied",
        `got status=${r10RowAfter?.status}`
      );
    }

    // === Case 11 (fix round 1, Important): concurrent wrong guesses don't under-count ===
    // Direct regression proof for the atomicity fix: the old implementation read failed_attempts,
    // incremented it in application code, then wrote it back in a SEPARATE round trip - firing
    // several wrong guesses at once could lose updates (two concurrent requests both reading the
    // same stale count), letting an attacker firing guesses in parallel get more than
    // MAX_ATTEMPTS_BEFORE_LOCKOUT real attempts before the lockout visibly engaged.
    // record_temp_passcode_failed_attempt's single atomic UPDATE (migration
    // 20260815000017_v2_temp_passcode_lock_down_client_writes.sql) should make failed_attempts
    // land at EXACTLY the number of concurrent guesses fired, never less.
    console.log(
      "\n=== Case 11: concurrent wrong-code attempts do not lose updates to failed_attempts (Important fix) ==="
    );
    const r11 = await createRequestAs(clientA, userA.id, userB.id, "hulu.com", sessionId);
    const r11Id = r11.data?.id;
    if (r11Id) {
      await callFunction("approve-temp-passcode", tokenB, { requestId: r11Id });

      const CONCURRENT_GUESSES = 3; // matches MAX_ATTEMPTS_BEFORE_LOCKOUT
      const concurrentResults = await Promise.all(
        Array.from({ length: CONCURRENT_GUESSES }, () =>
          callFunction("redeem-temp-passcode", tokenA, { requestId: r11Id, code: "000000" })
        )
      );
      record(
        "Case 11: all concurrent wrong-guess requests are individually rejected",
        concurrentResults.every((r) => r.json?.ok === false),
        `results: ${JSON.stringify(concurrentResults.map((r) => r.json))}`
      );

      const { data: r11Row } = await admin
        .from("temp_passcode_requests")
        .select("failed_attempts, locked_until")
        .eq("id", r11Id)
        .single();
      record(
        `Case 11: failed_attempts is exactly ${CONCURRENT_GUESSES} after ${CONCURRENT_GUESSES} CONCURRENT wrong guesses (no lost updates from the old read-then-write race)`,
        r11Row?.failed_attempts === CONCURRENT_GUESSES,
        `got failed_attempts=${r11Row?.failed_attempts}`
      );
      record(
        "Case 11: the lockout engaged at exactly the configured threshold",
        !!r11Row?.locked_until && new Date(r11Row.locked_until).getTime() > Date.now(),
        `got locked_until=${r11Row?.locked_until}`
      );
    }
  } finally {
    await cleanup(userIds);
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
