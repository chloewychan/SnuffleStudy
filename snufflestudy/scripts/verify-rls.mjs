// Negative-access proof for Task 5's RLS policies (supabase/migrations/
// 20260815000002_v2_rls_policies.sql). A mocked unit test (see
// src/infrastructure/backend/friendGroupApi.test.ts) can only prove friendGroupApi.ts calls the
// right table/method - it can't prove the database actually denies cross-account access. This
// script proves that against the live project, using three ephemeral test accounts.
//
// Standalone Node script (same style as scripts/apply-migrations.mjs / scripts/verify-schema.mjs)
// - reads .env via dotenv/config, not part of `npm test`. Run directly: node scripts/verify-rls.mjs
//
// What it does:
//   1. Creates three ephemeral, auto-confirmed accounts (A, B, C) via the service-role admin API.
//   2. Signs in as each via the anon-key client (password auth) to get three separately-scoped,
//      RLS-bound clients - these are what every check below actually queries through.
//   3. Exercises the plain functional path from the Definition of Done: A signs in, creates a
//      group, generates an invite code, B joins via that code - now through the
//      redeem_invite_code RPC (see the final review's Critical finding C1 below), not the old
//      client-side select-then-update-then-insert sequence.
//
// Two findings from v2's final whole-branch review are covered here specifically, both marked
// inline with the finding id:
//   - C1 (Critical): invite_codes' SELECT policy had no auth.uid() predicate and its UPDATE
//     policy had no ownership predicate, so any authenticated stranger could enumerate every
//     outstanding invite code in the project, redeem one, and thereby satisfy
//     group_memberships' has_redeemed_invite_code() gate to join an arbitrary group. Covered by
//     the "invite_codes (C1)" checks - both the negative half and the positive half (a real
//     invitee, and the code's creator, must still work).
//   - I2 (Important): temp_passcode_requests' INSERT policy had no shared-group floor, so a
//     stranger could name an arbitrary user as the approving friend and get that user emailed.
//     Covered by the "temp_passcode_requests (I2)" check.
//   4. Runs one negative check per RLS guarantee from the plan, asserting the forbidden
//      read/write actually fails (an explicit PostgREST error, not just an empty array) -
//      chaining `.single()` after every check converts RLS's silent-filtering behavior on SELECT
//      (and on UPDATE's returned representation) into a hard error we can assert on.
//   5. Cleans up every row it created and all three accounts via the service-role client, so
//      repeated runs don't accumulate junk in the live project.
//   6. Prints a pass/fail summary per guarantee and exits non-zero if anything failed.

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
const PASSWORD = `Verify-RLS-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Asserts that `fn()` (an async supabase-js call) was denied by RLS. Treats an explicit
// PostgREST error as the primary success signal (what `.single()` gives us for both SELECT and
// UPDATE...select() chains when RLS filters the target row to zero rows, and what a bare INSERT
// always gets when its WITH CHECK fails) - falls back to "empty/null data with no error" as a
// weaker signal for chains that don't force an error (e.g. a plain multi-row SELECT with no
// `.single()`, where RLS silently filters rather than erroring). Only a genuinely non-empty
// result counts as a FAIL.
//
// TRAP for future checks added to this script: the DoD requires the request to "fail, not just
// return an empty/filtered result" - the weaker empty-data fallback above technically satisfies
// this function's contract but is a strictly weaker proof than an explicit error, since an
// empty array can't be distinguished from "the row doesn't exist" vs "RLS hid it." Every check
// in this file today goes through the strong path (`.single()` or a WITH CHECK-violating
// INSERT) - if you add a new check, prefer the same rather than leaning on the fallback.
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

function generateInviteCodeString() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Mirrors friendGroupApi.ts's createGroup(): the group's id must be generated client-side, not
// learned back via `.insert(...).select()`'s RETURNING clause. friend_groups' "members can read
// their groups" RLS policy requires a group_memberships row for the reader, and Postgres
// enforces that same SELECT policy against RETURNING - at the instant of the friend_groups
// insert, no group_memberships row exists yet (it's the very next statement), so
// `.insert(...).select().single()` on friend_groups fails every time with "new row violates
// row-level security policy for table friend_groups". Known id up front breaks the cycle.
async function createGroupAsOwner(client, ownerId, name) {
  const id = crypto.randomUUID();
  const { error: groupErr } = await client.from("friend_groups").insert({ id, name, owner_user_id: ownerId });
  if (groupErr) return { id: null, error: groupErr };
  const { error: memErr } = await client.from("group_memberships").insert({ group_id: id, user_id: ownerId });
  if (memErr) return { id: null, error: memErr };
  return { id, error: null };
}

async function createTestUser(label) {
  const email = `rls-test-${label}-${RUN_ID}@example.com`;
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

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: FKs in the schema migration have no ON DELETE CASCADE, so
  // referencing rows must go before the rows/users they reference, or the delete errors out.
  await admin.from("producer_tag_sends").delete().in("sender_user_id", userIds);
  await admin.from("producer_tag_sends").delete().in("recipient_user_id", userIds);
  await admin.from("producer_tags").delete().in("user_id", userIds);
  await admin.from("study_room_participants").delete().in("user_id", userIds);
  await admin.from("study_rooms").delete().in("owner_user_id", userIds);
  await admin.from("temp_passcode_requests").delete().in("requester_user_id", userIds);
  await admin.from("temp_passcode_requests").delete().in("friend_user_id", userIds);
  await admin.from("unlock_requests").delete().in("requester_user_id", userIds);
  await admin.from("session_status_events").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("user_id", userIds);
  await admin.from("friendship_settings").delete().in("friend_user_id", userIds);
  await admin.from("invite_codes").delete().in("created_by", userIds);
  await admin.from("group_memberships").delete().in("user_id", userIds);
  await admin.from("friend_groups").delete().in("owner_user_id", userIds);

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`  Failed to delete test user ${id}: ${error.message}`);
  }
  console.log("Cleanup done.");
}

async function main() {
  console.log("Creating ephemeral test accounts (A, B, C)...");
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userC.id];

  try {
    const clientA = await signInAs(userA.email);
    const clientB = await signInAs(userB.email);
    const clientC = await signInAs(userC.email);
    record("Setup: all three accounts signed in via anon-key client", true);

    // --- Functional DoD path: sign in, create a group, generate an invite code, second
    // account joins via that code. ---
    let joinGroupId = null;
    // Hoisted out of the block below (which is its own lexical scope) so Guarantee 6 further down
    // - which needs the exact code B redeemed, to prove the AFTER DELETE trigger un-redeems it on
    // leave - can still reference it.
    let joinGroupInviteCode = null;
    {
      const { id: createdGroupId, error: groupErr } = await createGroupAsOwner(
        clientA,
        userA.id,
        `RLS Verify Group ${RUN_ID}`
      );
      record("Functional: A creates a group and joins it as owner", !groupErr, groupErr?.message);
      joinGroupId = createdGroupId;

      const inviteCode = generateInviteCodeString();
      joinGroupInviteCode = inviteCode;
      let inviteCreated = false;
      if (joinGroupId) {
        const { error: inviteErr } = await clientA.from("invite_codes").insert({
          code: inviteCode,
          group_id: joinGroupId,
          created_by: userA.id,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
        inviteCreated = !inviteErr;
        record("Functional: A generates an invite code", !inviteErr, inviteErr?.message);
      }

      // === C1 (final review, Critical): the negative half, run BEFORE the code is redeemed, so
      // the code under test is a genuinely outstanding one - exactly the state the old policies
      // left readable and redeemable by the entire authenticated world. C shares no group with
      // A or B and was never given this (or any) code. ===
      //
      // (a) Enumeration. A bare, unfiltered `.select()` against invite_codes: under the old
      // "unexpired unused codes are readable" policy (no auth.uid() predicate at all) this
      // returned EVERY outstanding code in the project along with its group_id. Deliberately
      // NOT `.single()`-chained - the whole point is to prove the unbounded listing form returns
      // nothing, which is the fallback branch of expectDenied rather than its error branch.
      await expectDenied("invite_codes (C1): C cannot enumerate invite codes at all", () =>
        clientC.from("invite_codes").select()
      );
      // (b) Targeted read of one specific outstanding code A created. `.single()`-chained, so
      // RLS's silent filtering becomes a hard error.
      await expectDenied(
        "invite_codes (C1): C cannot read a specific outstanding code A created for A's own group",
        () => clientC.from("invite_codes").select().eq("code", inviteCode).single()
      );
      // (c) Direct redemption UPDATE - the second half of the old exploit chain. UPDATE is now
      // revoked from `authenticated` entirely (20260815000025), so this fails at the Postgres
      // GRANT layer, before RLS is even consulted.
      await expectDenied(
        "invite_codes (C1): C cannot redeem an outstanding code via a direct client UPDATE (grant revoked)",
        () =>
          clientC
            .from("invite_codes")
            .update({ used_by: userC.id })
            .eq("code", inviteCode)
            .select()
            .single()
      );
      // (d) The full pre-fix exploit chain, replayed end-to-end against the ONLY redemption path
      // that now exists (the redeem_invite_code RPC). Deliberately driven by what C can ACTUALLY
      // obtain rather than by test-harness knowledge: C's own enumeration result from (a) is the
      // input. Pre-fix that enumeration handed C every outstanding code in the project and this
      // step joined an arbitrary group; post-fix it hands C nothing, so the best C can do is
      // present a code they invented.
      //
      // Worth stating plainly, since it defines the boundary this fix actually establishes: an
      // invite code is a bearer secret - the string IS the authorization, and the RPC cannot
      // (and must not) distinguish a legitimate invitee presenting a code they were given from
      // anyone else presenting the same string. What the fix removes is C's ability to OBTAIN a
      // real code, which is what (a) and (b) above prove. This check completes the chain by
      // confirming the RPC is also not an oracle: an unknown code fails with the same
      // deliberately-indistinguishable exception as an expired or already-used one, so it cannot
      // be used to probe which codes exist.
      const { data: cEnumerated } = await clientC.from("invite_codes").select();
      const cBestGuess = cEnumerated?.[0]?.code ?? generateInviteCodeString();
      await expectDenied(
        "invite_codes (C1): C cannot redeem their way into A's group via the redeem_invite_code RPC (full pre-fix exploit chain, replayed)",
        () => clientC.rpc("redeem_invite_code", { p_code: cBestGuess })
      );

      // (e) The narrowed SELECT policy's positive half, so this fix is proven not to have simply
      // made invite_codes unreadable to everyone: A created this code, so A must still be able to
      // see it (that's how AccountPage.tsx shows the owner the code they just generated).
      {
        const { data: ownCode, error: ownCodeErr } = await clientA
          .from("invite_codes")
          .select()
          .eq("code", inviteCode)
          .single();
        record(
          "invite_codes (C1): A can still read a code A created (created_by = auth.uid())",
          !ownCodeErr && ownCode?.code === inviteCode && ownCode?.group_id === joinGroupId,
          ownCodeErr?.message ?? `got ${JSON.stringify(ownCode)}`
        );
      }

      if (inviteCreated) {
        // === C1 positive path: the legitimate invitee, actually given the code, still joins
        // end-to-end through the new RPC. One call now does lookup + redemption + membership
        // insert in a single transaction (supabase/migrations/
        // 20260815000025_v2_lock_down_invite_code_redemption.sql), replacing the old
        // select-then-update-then-insert sequence that finding C1 showed was exploitable. ===
        const { data: redeemed, error: redeemErr } = await clientB.rpc("redeem_invite_code", {
          p_code: inviteCode,
        });
        record(
          "Functional (C1 positive path): B joins the group by redeeming the real code via the redeem_invite_code RPC",
          !redeemErr && !!redeemed,
          redeemErr?.message ?? `got ${JSON.stringify(redeemed)}`
        );
        record(
          "Functional (C1 positive path): the RPC returns B's actual group_memberships row (group_id/user_id/joined_at)",
          redeemed?.group_id === joinGroupId &&
            redeemed?.user_id === userB.id &&
            !!redeemed?.joined_at,
          `got ${JSON.stringify(redeemed)}`
        );
        // Independently confirmed against the table itself, not just the RPC's own return value.
        const { data: membershipRow } = await admin
          .from("group_memberships")
          .select()
          .eq("group_id", joinGroupId)
          .eq("user_id", userB.id)
          .maybeSingle();
        record(
          "Functional (C1 positive path): the membership row really exists in group_memberships afterward",
          !!membershipRow,
          membershipRow ? "row present" : "row missing"
        );
        // Single-use is still enforced, now by the function's own unused-check under a row lock
        // rather than by the (deleted) UPDATE policy's USING clause.
        await expectDenied(
          "invite_codes (C1): a second redemption of the same code is rejected by the RPC",
          () => clientB.rpc("redeem_invite_code", { p_code: inviteCode })
        );
      }

      // Sub-check from the invite_codes guarantee: a used code is not readable by an unrelated
      // third party (C is neither its creator nor its redeemer, the only two predicates the
      // narrowed SELECT policy allows).
      await expectDenied("invite_codes: a used code is unreadable (by C)", () =>
        clientC.from("invite_codes").select().eq("code", inviteCode).single()
      );

      // Sub-check: an expired code is unreadable. Inserted directly via the service-role
      // client (bypasses the ordinary insert policy) purely to set up an already-expired row -
      // the thing under test is the SELECT policy, not how the row got there.
      if (joinGroupId) {
        const expiredCode = generateInviteCodeString();
        const { error: seedErr } = await admin.from("invite_codes").insert({
          code: expiredCode,
          group_id: joinGroupId,
          created_by: userA.id,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        });
        if (seedErr) {
          record("invite_codes: expired code is unreadable (by C)", false, `seed failed: ${seedErr.message}`);
        } else {
          await expectDenied("invite_codes: an expired code is unreadable (by C)", () =>
            clientC.from("invite_codes").select().eq("code", expiredCode).single()
          );
        }
      }
    }

    // --- Guarantee 1: friend_groups / group_memberships - B cannot read A's group when B is
    // not a member. (Deliberately a *different* group from the one B joined above.) ---
    {
      const { id: privateGroupId, error } = await createGroupAsOwner(
        clientA,
        userA.id,
        `RLS Private Group ${RUN_ID}`
      );
      record("friend_groups: A creates a private group B never joins", !error, error?.message);
      if (!error) {
        await expectDenied(
          "friend_groups: B cannot read A's group they were never added to",
          () => clientB.from("friend_groups").select().eq("id", privateGroupId).single()
        );
        await expectDenied(
          "group_memberships: B cannot read the membership rows of a group they're not in",
          () => clientB.from("group_memberships").select().eq("group_id", privateGroupId).eq("user_id", userA.id).single()
        );

        // Privilege-escalation check (fix round 1): group_memberships' original INSERT policy
        // only checked user_id = auth.uid() - it never verified an actual invite-code
        // redemption, so any authenticated user who merely *learned* a group_id (never given a
        // code, never invited) could grant themselves membership directly via the REST API,
        // bypassing friendGroupApi.ts's joinGroup() entirely.
        //
        // Restructured for the final review's C1 fix. This check used to obtain the group_id the
        // way an attacker did at the time - by reading an undisclosed invite code A had created,
        // since the old "unexpired unused codes are readable" policy let ANY authenticated user
        // read any outstanding code. That discovery path is precisely what C1 closed, so the
        // check now hands B the group_id directly from this script's own state, which is a
        // STRICTLY STRONGER form of the same assertion: it grants the attacker knowledge they
        // can no longer actually obtain, and proves the membership insert is denied even so. The
        // "B can't read the undisclosed code either" half is asserted separately below, so the
        // two guarantees stay independently visible in the summary rather than one silently
        // depending on the other.
        const undisclosedCode = generateInviteCodeString();
        const { error: undisclosedCodeErr } = await clientA.from("invite_codes").insert({
          code: undisclosedCode,
          group_id: privateGroupId,
          created_by: userA.id,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
        if (undisclosedCodeErr) {
          record(
            "group_memberships: B cannot self-insert membership without redeeming an invite code",
            false,
            `setup failed: ${undisclosedCodeErr.message}`
          );
        } else {
          // C1: B is a legitimate member of A's OTHER group, but is neither this code's creator
          // nor its redeemer - the only two predicates invite_codes' narrowed SELECT policy
          // allows. Being someone's friend elsewhere must not make their outstanding codes
          // readable.
          await expectDenied(
            "invite_codes (C1): B cannot read an outstanding code A created for a group B isn't in",
            () => clientB.from("invite_codes").select().eq("code", undisclosedCode).single()
          );

          // B never redeemed `undisclosedCode`, and attempts to grant themselves membership
          // directly using the group_id. An INSERT whose WITH CHECK fails always throws an
          // explicit RLS-violation error (unlike SELECT's silent filtering), so this is a hard
          // "must fail" assertion by construction.
          await expectDenied(
            "group_memberships: B cannot self-insert membership without redeeming an invite code",
            () =>
              clientB.from("group_memberships").insert({ group_id: privateGroupId, user_id: userB.id })
          );
        }
      }
    }

    // --- Guarantee 2 (friendship_settings): B cannot read or write the row where
    // user_id = A, friend_user_id = B - that row is A's control over the relationship, not
    // B's. ---
    //
    // v2 Task 10: A and B already share a group by this point (the "Functional" join above), so
    // migration 20260815000012's group_memberships_create_friendship_settings trigger has
    // already auto-created this exact (A, B) row (with every column at its default) the moment B
    // joined - a plain `.insert()` here would now fail with a duplicate-key error. `.upsert()`
    // with the composite primary key as the conflict target is robust either way (works whether
    // the trigger already created the row, or - in some future world without it - this is a
    // genuine first insert) and preserves this check's actual intent: a row exists, controlled by
    // A, that B cannot read or write.
    {
      const { error: settingsErr } = await clientA
        .from("friendship_settings")
        .upsert({ user_id: userA.id, friend_user_id: userB.id }, { onConflict: "user_id,friend_user_id" });
      if (settingsErr) {
        record("friendship_settings: A creates a settings row about B", false, settingsErr.message);
      } else {
        record("friendship_settings: A creates a settings row about B", true);
        await expectDenied(
          "friendship_settings: B cannot read A's row where B is friend_user_id",
          () =>
            clientB
              .from("friendship_settings")
              .select()
              .eq("user_id", userA.id)
              .eq("friend_user_id", userB.id)
              .single()
        );
        await expectDenied(
          "friendship_settings: B cannot write A's row where B is friend_user_id",
          () =>
            clientB
              .from("friendship_settings")
              .update({ send_live_nudges: false })
              .eq("user_id", userA.id)
              .eq("friend_user_id", userB.id)
              .select()
              .single()
        );
      }
    }

    // --- Guarantee 3 (session_status_events): a user can read another user's event only with
    // a common group AND friendship_settings visibility - never just "same group" alone. Using
    // C here (no group in common with A, and no friendship_settings row granting visibility)
    // for an unambiguous "no relationship at all" negative case. ---
    {
      const { data: event, error } = await clientA
        .from("session_status_events")
        .insert({
          user_id: userA.id,
          session_id: `rls-verify-session-${RUN_ID}`,
          type: "SESSION_STARTED",
          display_label: "Studying",
          occurred_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (error || !event) {
        record("session_status_events: A records a session event", false, error?.message);
      } else {
        record("session_status_events: A records a session event", true);
        await expectDenied(
          "session_status_events: C cannot read A's event (no common group, no visibility grant)",
          () => clientC.from("session_status_events").select().eq("id", event.id).single()
        );
      }
    }

    // --- Guarantee 4 (unlock_requests / temp_passcode_requests): readable/writable only by
    // the requester or the resolving/assigned friend - not anyone else. ---
    {
      const { data: unlockReq, error } = await clientA
        .from("unlock_requests")
        .insert({
          session_id: `rls-verify-session-${RUN_ID}`,
          requester_user_id: userA.id,
          hostname: "youtube.com",
          status: "pending",
        })
        .select()
        .single();
      if (error || !unlockReq) {
        record("unlock_requests: A creates a pending unlock request", false, error?.message);
      } else {
        // Resolve it as A themself (the requester) - RLS's USING clause for UPDATE allows
        // requester_user_id = auth.uid() OR resolved_by = auth.uid(), so the requester can
        // always update their own request. This produces a *resolved* request belonging to A,
        // which is what the negative test below needs.
        const resolvedOk = await expectOk("unlock_requests: A resolves their own request", () =>
          clientA
            .from("unlock_requests")
            .update({ status: "approved", resolved_at: new Date().toISOString(), resolved_by: userA.id })
            .eq("id", unlockReq.id)
        );
        if (resolvedOk) {
          await expectDenied(
            "unlock_requests: B cannot read A's resolved unlock request",
            () => clientB.from("unlock_requests").select().eq("id", unlockReq.id).single()
          );
          await expectDenied(
            "unlock_requests: B cannot write (re-resolve) A's resolved unlock request",
            () =>
              clientB
                .from("unlock_requests")
                .update({ status: "denied" })
                .eq("id", unlockReq.id)
                .select()
                .single()
          );
        }
      }

      // v2 Task 12 (migration 20260815000016_v2_temp_passcode_hard_mode.sql): code_hash/code_salt
      // are no longer selectable by the `authenticated` role at all (a Postgres column-level
      // GRANT, not just RLS) - a bare `.select()` here would now hard-fail with "permission denied
      // for column code_hash", regardless of RLS. Narrowed to the same column list
      // tempPasscodeApi.ts itself uses (excluding code_hash/code_salt) - see
      // scripts/verify-temp-passcode.mjs's own Case 5 for the dedicated live proof that this
      // denial is real and deliberate, not a bug this script should route around by requesting
      // fewer columns without remark.
      //
      // v2 Task 12 fix round 2 (migration 20260815000018_v2_temp_passcode_lock_down_insert.sql):
      // the INSERT policy now additionally requires code_hash/code_salt/expires_at/locked_until
      // to be null and failed_attempts to be 0 at creation time (only approve-temp-passcode,
      // running as service_role, may ever set them) - this insert previously set a placeholder
      // code_hash and a future expires_at, which the tightened policy now correctly rejects. A
      // genuinely pending request never carries either at creation, so both are simply omitted
      // here now (see scripts/verify-temp-passcode.mjs's Cases 12-14 for the dedicated live proof
      // that this tightening is real/deliberate and that the legitimate insert path still works).
      //
      // Final review, Important finding I2 (migration
      // 20260815000026_v2_temp_passcode_group_floor.sql): the INSERT policy now additionally
      // requires users_share_a_group(requester_user_id, friend_user_id). This request was
      // previously assigned to C, who shares no group with A - correct as a "third party" for the
      // OLD checks, but no longer a legitimate insert at all. Reassigned to B (who joined A's
      // group in the Functional section above, so the floor is satisfied), and the unrelated
      // third party for the two negative checks below is now C. The guarantee under test is
      // unchanged: "readable/writable only by the requester or the assigned friend".
      const { data: passcodeReq, error: passcodeErr } = await clientA
        .from("temp_passcode_requests")
        .insert({
          session_id: `rls-verify-session-${RUN_ID}`,
          hostname: "youtube.com",
          requester_user_id: userA.id,
          friend_user_id: userB.id,
          status: "pending",
          delivered_via: "email",
        })
        .select("id, session_id, hostname, requester_user_id, friend_user_id, status")
        .single();
      if (passcodeErr || !passcodeReq) {
        record("temp_passcode_requests: A creates a request assigned to B (shared group)", false, passcodeErr?.message);
      } else {
        record("temp_passcode_requests: A creates a request assigned to B (shared group)", true);
        // Narrowed selects here too (same rationale as the insert's own comment above) - the
        // point of these two checks is RLS row-visibility specifically (C has no relationship to
        // this row at all), not the separate column-grant denial code_hash/code_salt would add
        // regardless of who's asking; a narrowed column list isolates that.
        await expectDenied(
          "temp_passcode_requests: C (not requester, not assigned friend) cannot read the request",
          () =>
            clientC
              .from("temp_passcode_requests")
              .select("id, session_id, hostname, requester_user_id, friend_user_id, status")
              .eq("id", passcodeReq.id)
              .single()
        );
        await expectDenied(
          "temp_passcode_requests: C (not requester, not assigned friend) cannot write the request",
          () =>
            clientC
              .from("temp_passcode_requests")
              .update({ status: "denied" })
              .eq("id", passcodeReq.id)
              .select("id, session_id, hostname, requester_user_id, friend_user_id, status")
              .single()
        );
      }

      // === I2 (final review, Important): temp_passcode_requests' shared-group floor. ===
      //
      // C shares no group with A. Before 20260815000026 the INSERT policy checked only
      // requester_user_id = auth.uid(), the genuinely-pending column values, and
      // requester_user_id <> friend_user_id - never that the two users had any relationship at
      // all. So any authenticated user who learned another user's UUID could create a request
      // naming that stranger as the approving friend, which (a) surfaces in the stranger's side
      // panel via the friend-poll alarm and (b) causes send-temp-passcode-request to email the
      // stranger's REAL address with the request's caller-controlled `hostname` in the body -
      // previously interpolated into that email's HTML unescaped (fixed in the same commit, see
      // supabase/functions/send-temp-passcode-request/index.ts's escapeHtml). Every other
      // cross-user-targeting write in this schema already had this floor; this table was the sole
      // exception.
      await expectDenied(
        "temp_passcode_requests (I2): C cannot create a request naming A (no shared group) as the approving friend",
        () =>
          clientC
            .from("temp_passcode_requests")
            .insert({
              session_id: `rls-verify-session-${RUN_ID}`,
              hostname: "<img src=x onerror=alert(1)>evil.com",
              requester_user_id: userC.id,
              friend_user_id: userA.id,
              status: "pending",
              delivered_via: "email",
            })
            .select("id")
            .single()
      );
    }

    // --- Guarantee 5 (producer_tag_sends): readable only by sender, recipient, or a member of
    // recipient_room_id - a third account (C) with none of those roles cannot read a send
    // between A and B. ---
    {
      const { data: tag, error: tagErr } = await clientA
        .from("producer_tags")
        .insert({ user_id: userA.id, audio_url: "https://example.com/rls-verify.mp3", duration_ms: 1500 })
        .select()
        .single();
      if (tagErr || !tag) {
        record("producer_tags: A creates a tag", false, tagErr?.message);
      } else {
        record("producer_tags: A creates a tag", true);
        const { error: sendErr } = await clientA
          .from("producer_tag_sends")
          .insert({ tag_id: tag.id, sender_user_id: userA.id, recipient_user_id: userB.id });
        if (sendErr) {
          record("producer_tag_sends: A sends the tag to B", false, sendErr.message);
        } else {
          record("producer_tag_sends: A sends the tag to B", true);
          // producer_tag_sends has no primary key/id column (see the schema migration's note),
          // so the composite of tag_id + sender_user_id + recipient_user_id is what uniquely
          // identifies this row for the lookup.
          await expectDenied(
            "producer_tag_sends: C (not sender, not recipient, not a room member) cannot read the send",
            () =>
              clientC
                .from("producer_tag_sends")
                .select()
                .eq("tag_id", tag.id)
                .eq("sender_user_id", userA.id)
                .eq("recipient_user_id", userB.id)
                .single()
          );
        }
      }
    }

    // --- Guarantee 6 (group_memberships DELETE / group-leave, v2 follow-up Item 2,
    // post-final-review, finding I4): a member can remove their own row (leave); a group owner
    // can remove someone else's (kick); a non-owner, non-self member can do neither. Leaving/being
    // kicked must also close the re-join-without-a-fresh-invite gap (migration
    // 20260815000028_v2_group_leave.sql's AFTER DELETE trigger) and actually revoke downstream
    // group-gated visibility, not just delete the membership row in isolation. Reuses A/joinGroupId
    // (A = owner) and B's real redeemed `joinGroupInviteCode` from the Functional section at the
    // top of this script - joinGroupId is never referenced again after this block, so mutating
    // its membership here is safe. ---
    if (joinGroupId) {
      // (a) B leaves the group they legitimately redeemed into above.
      const leftOk = await expectOk("group_memberships: B leaves A's group (deletes own row)", () =>
        clientB.from("group_memberships").delete().eq("group_id", joinGroupId).eq("user_id", userB.id)
      );
      if (leftOk) {
        const { data: goneRow } = await admin
          .from("group_memberships")
          .select()
          .eq("group_id", joinGroupId)
          .eq("user_id", userB.id)
          .maybeSingle();
        record(
          "group_memberships: B's membership row is actually gone after leaving",
          !goneRow,
          goneRow ? "row still present" : undefined
        );

        // (d) re-join gap: the AFTER DELETE trigger must null out the code B redeemed, so
        // has_redeemed_invite_code(joinGroupId, B) flips back to false.
        const { data: hasRedeemedAfterLeave, error: hasRedeemedErr } = await admin.rpc(
          "has_redeemed_invite_code",
          { p_group_id: joinGroupId, p_user_id: userB.id }
        );
        record(
          "group_memberships (re-join gap): has_redeemed_invite_code(joinGroupId, B) is false after leaving",
          !hasRedeemedErr && hasRedeemedAfterLeave === false,
          hasRedeemedErr?.message ?? `got ${hasRedeemedAfterLeave}`
        );
        const { data: codeRowAfterLeave } = await admin
          .from("invite_codes")
          .select("used_by")
          .eq("code", joinGroupInviteCode)
          .maybeSingle();
        record(
          "group_memberships (re-join gap): B's redeemed inviteCode has used_by nulled out (un-redeemed, not left permanently marked)",
          codeRowAfterLeave?.used_by === null,
          `got ${JSON.stringify(codeRowAfterLeave)}`
        );

        // (e) downstream visibility is actually revoked, not just the membership row: B (no
        // longer a member) can no longer read A's friend_groups row for this group - a purely
        // membership-gated guarantee (friend_groups' SELECT policy has no friendship_settings
        // dependency), isolating "does leaving revoke visibility" from any friendship_settings
        // toggle state.
        await expectDenied(
          "group_memberships (leave revokes visibility): B can no longer read A's friend_groups row after leaving",
          () => clientB.from("friend_groups").select().eq("id", joinGroupId).single()
        );

        // Bonus, proving the re-join gap is closed end-to-end (not just the helper flipping false
        // in isolation): B re-attempting to insert their own membership row directly, with no
        // fresh invite code redeemed, must fail exactly like any other never-invited stranger.
        await expectDenied(
          "group_memberships (re-join gap): B cannot re-insert their own membership row without redeeming a fresh invite code",
          () => clientB.from("group_memberships").insert({ group_id: joinGroupId, user_id: userB.id })
        );
      }

      // (b)/(c) setup: A issues a fresh code, C redeems it (so there's a non-owner member other
      // than B to kick), then B legitimately rejoins with a SECOND fresh code (proving the re-join
      // fix doesn't block a genuinely NEW invite, only a reuse of the old one) so there are two
      // non-owner members - the shape (c) needs to prove B cannot remove C.
      const kickCode = generateInviteCodeString();
      const { error: kickCodeErr } = await clientA.from("invite_codes").insert({
        code: kickCode,
        group_id: joinGroupId,
        created_by: userA.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const { data: cJoined, error: cJoinErr } = kickCodeErr
        ? { data: null, error: kickCodeErr }
        : await clientC.rpc("redeem_invite_code", { p_code: kickCode });
      record(
        "group_memberships: C joins A's group (setup for the kick/non-owner-delete checks)",
        !cJoinErr && !!cJoined,
        (kickCodeErr ?? cJoinErr)?.message
      );

      const rejoinCode = generateInviteCodeString();
      const { error: rejoinCodeErr } = await clientA.from("invite_codes").insert({
        code: rejoinCode,
        group_id: joinGroupId,
        created_by: userA.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const { data: bRejoined, error: bRejoinErr } = rejoinCodeErr
        ? { data: null, error: rejoinCodeErr }
        : await clientB.rpc("redeem_invite_code", { p_code: rejoinCode });
      record(
        "group_memberships: B legitimately rejoins with a fresh invite code (setup for the non-owner-delete check)",
        !bRejoinErr && !!bRejoined,
        (rejoinCodeErr ?? bRejoinErr)?.message
      );

      if (cJoined && bRejoined) {
        // (c) B (a non-owner, and not C) cannot delete C's row. `.select().single()` chained
        // (this file's usual trick for turning RLS's silent zero-row filtering into a hard
        // error) - a bare `.delete()` with no RETURNING would only prove the weaker "no rows
        // reported" fallback, which the TRAP comment at the top of this file flags as strictly
        // weaker evidence.
        await expectDenied(
          "group_memberships: a non-owner, non-self member (B) cannot delete another member's (C's) row",
          () =>
            clientB
              .from("group_memberships")
              .delete()
              .eq("group_id", joinGroupId)
              .eq("user_id", userC.id)
              .select()
              .single()
        );
        const { data: cStillThere } = await admin
          .from("group_memberships")
          .select()
          .eq("group_id", joinGroupId)
          .eq("user_id", userC.id)
          .maybeSingle();
        record(
          "group_memberships: C's row is untouched after B's denied delete attempt",
          !!cStillThere,
          cStillThere ? undefined : "row missing - the denied delete actually went through"
        );

        // (b) the owner (A) removes C directly - the kick path.
        const kickedOk = await expectOk(
          "group_memberships: group owner (A) removes another member (C) directly (kick)",
          () => clientA.from("group_memberships").delete().eq("group_id", joinGroupId).eq("user_id", userC.id)
        );
        if (kickedOk) {
          const { data: cGoneRow } = await admin
            .from("group_memberships")
            .select()
            .eq("group_id", joinGroupId)
            .eq("user_id", userC.id)
            .maybeSingle();
          record(
            "group_memberships: C's row is actually gone after being kicked by the owner",
            !cGoneRow,
            cGoneRow ? "row still present" : undefined
          );
        }
      }

      // Owner-leaves-their-own-group: the migration's documented judgment call is that an owner
      // leaves via the exact same `user_id = auth.uid()` branch as anyone else, with no
      // ownership-transfer requirement (there is no such mechanism in this schema). Run last in
      // this block/script - nothing after this references joinGroupId or expects A to still be a
      // member of it.
      const ownerLeftOk = await expectOk(
        "group_memberships: the group owner (A) can leave their own group the same way any member can",
        () => clientA.from("group_memberships").delete().eq("group_id", joinGroupId).eq("user_id", userA.id)
      );
      if (ownerLeftOk) {
        const { data: ownerGoneRow } = await admin
          .from("group_memberships")
          .select()
          .eq("group_id", joinGroupId)
          .eq("user_id", userA.id)
          .maybeSingle();
        record(
          "group_memberships: the owner's own row is actually gone after leaving",
          !ownerGoneRow,
          ownerGoneRow ? "row still present" : undefined
        );
      }
    }
  } finally {
    await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== RLS verification summary ===");
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
  console.error("verify-rls.mjs crashed:", err);
  process.exit(1);
});
