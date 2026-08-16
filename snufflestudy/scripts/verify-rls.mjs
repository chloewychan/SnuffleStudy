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
//      group, generates an invite code, B joins via that code.
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
    {
      const { id: createdGroupId, error: groupErr } = await createGroupAsOwner(
        clientA,
        userA.id,
        `RLS Verify Group ${RUN_ID}`
      );
      record("Functional: A creates a group and joins it as owner", !groupErr, groupErr?.message);
      joinGroupId = createdGroupId;

      const inviteCode = generateInviteCodeString();
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

      if (inviteCreated) {
        const { data: lookup, error: lookupErr } = await clientB
          .from("invite_codes")
          .select()
          .eq("code", inviteCode)
          .single();
        if (lookupErr || !lookup) {
          record("Functional: B looks up the invite code", false, lookupErr?.message);
        } else {
          // Redeem BEFORE inserting membership - mirrors friendGroupApi.ts's joinGroup() order
          // (fix round 1). group_memberships' INSERT policy (supabase/migrations/
          // 20260815000005_v2_gate_group_membership_on_invite.sql) requires a matching
          // invite_codes row with used_by = auth.uid() to already exist, so redemption must
          // happen first or the membership insert's WITH CHECK has nothing to find.
          const { error: markErr } = await clientB
            .from("invite_codes")
            .update({ used_by: userB.id })
            .eq("code", inviteCode);
          const { error: joinErr } = await clientB
            .from("group_memberships")
            .insert({ group_id: lookup.group_id, user_id: userB.id });
          record(
            "Functional: B joins the group via the invite code and redeems it",
            !joinErr && !markErr,
            joinErr?.message || markErr?.message
          );
        }
      }

      // Sub-check from the invite_codes guarantee: a used code is no longer readable (by
      // anyone, including the account that redeemed it - the RLS select policy only allows
      // unexpired+unused rows through).
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
        // bypassing friendGroupApi.ts's joinGroup() entirely. Reproduces the exact discovery
        // path too: A generates a code for the private group that's never handed to B, but
        // invite_codes' "unexpired unused codes are readable" policy lets *any* authenticated
        // user read it (and thus learn group_id) before it's redeemed - proving the group_id
        // alone was never secret, only a *redeemed* code should grant membership.
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
          const { data: discovered, error: discoverErr } = await clientB
            .from("invite_codes")
            .select()
            .eq("code", undisclosedCode)
            .single();
          if (discoverErr || !discovered) {
            record(
              "group_memberships: B cannot self-insert membership without redeeming an invite code",
              false,
              `expected B to be able to read the unredeemed code's group_id (proving it isn't secret) - ${discoverErr?.message}`
            );
          } else {
            // B never redeemed `undisclosedCode` - just read its group_id off it - then
            // attempts to grant themselves membership directly. An INSERT whose WITH CHECK
            // fails always throws an explicit RLS-violation error (unlike SELECT's silent
            // filtering), so this is a hard "must fail" assertion by construction.
            await expectDenied(
              "group_memberships: B cannot self-insert membership without redeeming an invite code",
              () =>
                clientB
                  .from("group_memberships")
                  .insert({ group_id: discovered.group_id, user_id: userB.id })
            );
          }
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
      const { data: passcodeReq, error: passcodeErr } = await clientA
        .from("temp_passcode_requests")
        .insert({
          session_id: `rls-verify-session-${RUN_ID}`,
          hostname: "youtube.com",
          requester_user_id: userA.id,
          friend_user_id: userC.id,
          status: "pending",
          delivered_via: "email",
        })
        .select("id, session_id, hostname, requester_user_id, friend_user_id, status")
        .single();
      if (passcodeErr || !passcodeReq) {
        record("temp_passcode_requests: A creates a request assigned to C", false, passcodeErr?.message);
      } else {
        record("temp_passcode_requests: A creates a request assigned to C", true);
        // Narrowed selects here too (same rationale as the insert's own comment above) - the
        // point of these two checks is RLS row-visibility specifically (B has no relationship to
        // this row at all), not the separate column-grant denial code_hash/code_salt would add
        // regardless of who's asking; a narrowed column list isolates that.
        await expectDenied(
          "temp_passcode_requests: B (not requester, not assigned friend) cannot read the request",
          () =>
            clientB
              .from("temp_passcode_requests")
              .select("id, session_id, hostname, requester_user_id, friend_user_id, status")
              .eq("id", passcodeReq.id)
              .single()
        );
        await expectDenied(
          "temp_passcode_requests: B (not requester, not assigned friend) cannot write the request",
          () =>
            clientB
              .from("temp_passcode_requests")
              .update({ status: "denied" })
              .eq("id", passcodeReq.id)
              .select("id, session_id, hostname, requester_user_id, friend_user_id, status")
              .single()
        );
      }
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
