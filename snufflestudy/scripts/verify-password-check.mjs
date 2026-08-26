// Live end-to-end proof for v3.4 Task 6's Definition of Done: AUTH_SET_PASSWORD requires and
// verifies the CURRENT password before changing it, but only once one already exists - against
// the live dev Supabase project, not just inspected SQL/TypeScript.
//
// Standalone Node script (same style/conventions as scripts/verify-friendships.mjs /
// verify-friend-requests.mjs) - reads .env via dotenv/config, not part of `npm test`.
// Run directly: node scripts/verify-password-check.mjs
//
// What this exercises for real vs. what it simulates:
//   - Real: every Supabase Auth/Postgres call - admin.auth.admin.createUser, client.auth.
//     signInWithPassword, client.auth.updateUser, a profiles upsert as the caller's own client
//     (the exact call markPasswordSet() makes), and re-signing-in afterward to prove which
//     password actually works. These are the same supabase-js calls background/messageRouter.ts's
//     AUTH_SET_PASSWORD case and infrastructure/backend/profileApi.ts's markPasswordSet() make.
//   - Simulated: the chrome.runtime message-passing plumbing itself (AUTH_SET_PASSWORD as a
//     message type, extensionMessenger.ts's sendMessage) - there's no chrome.* runtime in a plain
//     Node script (same limitation verify-friendships.mjs's own header notes for
//     chrome.notifications). This script instead calls the same messageRouter.ts case's LOGIC
//     directly, inlined below as runAuthSetPassword(), issuing the identical sequence of
//     supabase-js calls in the identical order/branching the real case does - not a hand-waved
//     approximation of it.
//
// Sequence, using one ephemeral, auto-confirmed test account:
//   1. Create the account via admin.auth.admin.createUser with NO password set - a profiles row
//      with password_set_at: null (an OTP-only account, mirroring how a brand-new/legacy account
//      looks before ever calling AUTH_SET_PASSWORD - see profileApi.ts's own comment).
//   2. Call the AUTH_SET_PASSWORD logic with no currentPassword. Since passwordSetAt is null,
//      this must succeed with no verification step, and profiles.password_set_at must now be set.
//   3. Negative case: call it again with a WRONG currentPassword. Must fail with "Current
//      password is incorrect.", and supabase.auth.updateUser must never be reached - proven by
//      signing in with the OLD password and confirming it still works (the password is
//      unchanged).
//   4. Call it again with the CORRECT currentPassword (the OLD one). Must succeed - sign-in with
//      the NEW password now works, sign-in with the OLD password now fails.
//   5. Clean up the test account; confirm via admin.auth.admin.listUsers() that it's gone.

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
const OLD_PASSWORD = `Verify-Pwd-Old-${crypto.randomUUID()}!`;
const NEW_PASSWORD = `Verify-Pwd-New-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function createTestUser(initialPassword) {
  const email = `password-check-test-${RUN_ID}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: initialPassword,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Failed to create test user: ${error?.message}`);
  }
  return { id: data.user.id, email };
}

function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signInAs(email, password) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  return { client, data, error };
}

// Mirrors profileApi.markPasswordSet() exactly - upsert onConflict: user_id, using the caller's
// own authenticated client (so it goes through the real "self can update own profile" RLS
// policy, not the service-role bypass).
async function markPasswordSetAs(client, userId) {
  return client
    .from("profiles")
    .upsert({ user_id: userId, password_set_at: new Date().toISOString() }, { onConflict: "user_id" });
}

// Mirrors messageRouter.ts's AUTH_SET_PASSWORD case exactly, branch-for-branch: reads the
// caller's own profiles row (mirroring profileApi.getMyProfile()), and only requires/verifies
// currentPassword when passwordSetAt is already set. `client` must be an already-signed-in
// client for the account being changed (same precondition the real case documents).
async function runAuthSetPassword(client, email, newPassword, currentPassword) {
  const { data: profileRow, error: profileErr } = await client
    .from("profiles")
    .select()
    .eq("user_id", (await client.auth.getUser()).data.user.id)
    .maybeSingle();
  if (profileErr) return { ok: false, error: profileErr.message };

  if (profileRow?.password_set_at) {
    if (!currentPassword) {
      return { ok: false, error: "Current password is required." };
    }
    const { data: sessionData } = await client.auth.getSession();
    const sessionEmail = sessionData.session?.user.email;
    if (!sessionEmail) {
      return { ok: false, error: "Could not verify your current password." };
    }
    const { error: verifyError } = await client.auth.signInWithPassword({
      email: sessionEmail,
      password: currentPassword,
    });
    if (verifyError) {
      return { ok: false, error: "Current password is incorrect." };
    }
  }

  const { error: updateError } = await client.auth.updateUser({ password: newPassword });
  if (updateError) return { ok: false, error: updateError.message };

  const userId = (await client.auth.getUser()).data.user.id;
  const { error: markError } = await markPasswordSetAs(client, userId);
  if (markError) return { ok: false, error: markError.message };

  return { ok: true };
}

async function cleanup(userId) {
  console.log("\nCleaning up test data...");
  if (userId) {
    await admin.from("profiles").delete().eq("user_id", userId);
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error && !error.message?.includes("User not found")) {
      console.error(`  Failed to delete test user ${userId}: ${error.message}`);
    }
  }
  console.log("Cleanup done.");
}

async function main() {
  console.log("Creating an ephemeral test account with NO password ever set...");
  // admin.auth.admin.createUser requires SOME password to be set at the Auth layer (there is no
  // "passwordless account" primitive in Supabase Auth itself) - what this script actually tests
  // is profiles.password_set_at being null, which is the ONLY signal messageRouter.ts's
  // AUTH_SET_PASSWORD case reads (see profileApi.ts's own comment: it's a proof-of-state column
  // this app manages itself, deliberately independent of whatever Supabase Auth's own internal
  // password state is). The account is created with a throwaway password it never uses again;
  // its profiles row is never given a password_set_at, matching a real OTP-only/legacy account.
  const throwawayInitialPassword = `Verify-Pwd-Unused-${crypto.randomUUID()}!`;
  const user = await createTestUser(throwawayInitialPassword);

  try {
    const { client: adminSeedClient, error: seedSignInErr } = await signInAs(
      user.email,
      throwawayInitialPassword
    );
    record("Setup: test account signs in via its throwaway initial password", !seedSignInErr, seedSignInErr?.message);

    const { error: profileInsertErr } = await adminSeedClient
      .from("profiles")
      .insert({ user_id: user.id, human_name: "Verify Password Check" });
    record(
      "Setup: test account has a profiles row with password_set_at left null",
      !profileInsertErr,
      profileInsertErr?.message
    );

    const { data: seedProfile, error: seedProfileErr } = await admin
      .from("profiles")
      .select("password_set_at")
      .eq("user_id", user.id)
      .single();
    record(
      "Precondition: profiles.password_set_at is null before any AUTH_SET_PASSWORD call",
      !seedProfileErr && seedProfile?.password_set_at === null,
      seedProfileErr?.message ?? `got ${JSON.stringify(seedProfile?.password_set_at)}`
    );

    // --- 1: first-ever AUTH_SET_PASSWORD, no currentPassword needed or sent ---
    const { client: clientForFirstSet, error: firstSignInErr } = await signInAs(
      user.email,
      throwawayInitialPassword
    );
    record("Signed in for the first AUTH_SET_PASSWORD call", !firstSignInErr, firstSignInErr?.message);

    const firstSetResult = await runAuthSetPassword(clientForFirstSet, user.email, OLD_PASSWORD, undefined);
    record(
      "AUTH_SET_PASSWORD succeeds with no currentPassword when passwordSetAt is null",
      firstSetResult.ok,
      firstSetResult.error
    );

    const { data: profileAfterFirstSet, error: afterFirstSetErr } = await admin
      .from("profiles")
      .select("password_set_at")
      .eq("user_id", user.id)
      .single();
    record(
      "profiles.password_set_at is now set after the first AUTH_SET_PASSWORD",
      !afterFirstSetErr && !!profileAfterFirstSet?.password_set_at,
      afterFirstSetErr?.message
    );

    // --- 2: negative case - wrong currentPassword ---
    const { client: clientForWrongAttempt, error: wrongSignInErr } = await signInAs(user.email, OLD_PASSWORD);
    record(
      "Signed in with the OLD password ahead of the wrong-currentPassword attempt",
      !wrongSignInErr,
      wrongSignInErr?.message
    );

    const wrongAttemptResult = await runAuthSetPassword(
      clientForWrongAttempt,
      user.email,
      NEW_PASSWORD,
      "definitely-the-wrong-password"
    );
    record(
      "AUTH_SET_PASSWORD rejects a WRONG currentPassword with 'Current password is incorrect.'",
      !wrongAttemptResult.ok && wrongAttemptResult.error === "Current password is incorrect.",
      JSON.stringify(wrongAttemptResult)
    );

    const { error: oldStillWorksErr } = await signInAs(user.email, OLD_PASSWORD);
    record(
      "Proof the password is UNCHANGED: sign-in with the OLD password still succeeds",
      !oldStillWorksErr,
      oldStillWorksErr?.message
    );
    const { error: newDoesNotWorkYetErr } = await signInAs(user.email, NEW_PASSWORD);
    record(
      "Proof the password is UNCHANGED: sign-in with the (rejected) NEW password still fails",
      !!newDoesNotWorkYetErr,
      newDoesNotWorkYetErr ? undefined : "sign-in with the new password unexpectedly SUCCEEDED"
    );

    // --- 3: correct currentPassword ---
    const { client: clientForCorrectAttempt, error: correctSignInErr } = await signInAs(
      user.email,
      OLD_PASSWORD
    );
    record(
      "Signed in with the OLD password ahead of the correct-currentPassword attempt",
      !correctSignInErr,
      correctSignInErr?.message
    );

    const correctAttemptResult = await runAuthSetPassword(
      clientForCorrectAttempt,
      user.email,
      NEW_PASSWORD,
      OLD_PASSWORD
    );
    record(
      "AUTH_SET_PASSWORD succeeds with the CORRECT currentPassword",
      correctAttemptResult.ok,
      correctAttemptResult.error
    );

    const { error: newNowWorksErr } = await signInAs(user.email, NEW_PASSWORD);
    record("Sign-in with the NEW password now succeeds", !newNowWorksErr, newNowWorksErr?.message);
    const { error: oldNoLongerWorksErr } = await signInAs(user.email, OLD_PASSWORD);
    record(
      "Sign-in with the OLD password now fails",
      !!oldNoLongerWorksErr,
      oldNoLongerWorksErr ? undefined : "sign-in with the old password unexpectedly still SUCCEEDED"
    );
  } finally {
    await cleanup(user.id);
  }

  const { data: remainingUsers, error: listErr } = await admin.auth.admin.listUsers();
  const stillExists = !listErr && (remainingUsers?.users ?? []).some((u) => u.id === user.id);
  record(
    "Cleanup confirmed via listUsers(): the test account no longer exists",
    !listErr && !stillExists,
    listErr?.message
  );

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Password-check verification summary ===");
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
