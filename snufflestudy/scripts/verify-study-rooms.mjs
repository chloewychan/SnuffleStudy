// Live end-to-end proof for Task 13's Definition of Done: "two test accounts in the same friend
// group can create/join the same room and see/hear each other over video; leaving a room updates
// presence for the remaining participant within a few seconds." A mocked unit test (see
// src/infrastructure/backend/studyRoomApi.test.ts / src/infrastructure/video/
// videoCallClient.test.ts) can only prove createRoom/joinRoom/leaveRoom/subscribeToPresence call
// the right table/columns and that videoCallClient.ts's connect/disconnect logic wires up
// correctly against a MOCKED LiveKit client - it can't prove the live database's RLS policies
// (supabase/migrations/20260815000019_v2_study_rooms_group_visibility_and_join_gate.sql) actually
// gate discovery/join the way they claim to, that Realtime's Postgres Changes stream actually
// fires live events over a real WebSocket, or that the deployed generate-livekit-token Edge
// Function actually mints/rejects tokens correctly server-side. This script proves all of that
// against the live project and the live deployed function.
//
// Standalone Node script (same style/conventions as scripts/verify-unlock-requests.mjs, the most
// structurally similar prior script - reuses its test-account/group-setup helpers) - reads .env
// via dotenv/config, not part of `npm test`. Run directly: node scripts/verify-study-rooms.mjs
//
// What it does:
//   1. Creates four ephemeral, auto-confirmed accounts via the service-role admin API: A (room
//      owner), B and D (A's group-mates in a shared group G1), C (a stranger in a different group
//      G2, sharing no group with A). Signs in as each via the anon-key client (password auth), so
//      every read/write below goes through the same RLS-bound client this codebase's real
//      studyRoomApi.ts would use.
//   2. Case 1 (discovery - the Part A fix): A creates study room R1. B (group-mate) CAN read R1
//      even before joining it (the actual chicken-and-egg gap this task's migration fixes). C (no
//      shared group with A) CANNOT read R1 at all.
//   3. Case 2 (join gate - the Part A write-side fix): C attempts to directly self-insert a
//      study_room_participants row for R1 without ever having a shared group with A - denied. B
//      (group-mate) successfully joins R1 (inserts their own participant row) - this is the
//      legitimate path studyRoomApi.ts's joinRoom() exercises.
//   4. Case 3 (presence via Supabase Realtime, live over a real WebSocket - first use of Realtime
//      anywhere in this codebase): A subscribes to R1's participant changes BEFORE D joins. D
//      (group-mate) then joins R1. Asserts A's subscription receives an INSERT postgres_changes
//      event for D's row within a few seconds. D then leaves (their own left_at update). Asserts
//      A's subscription receives a matching UPDATE event within a few seconds too - proving the
//      DoD's "leaving a room updates presence for the remaining participant within a few seconds"
//      claim end-to-end, not just that the RPC/table write succeeds.
//   5. Case 4 (generate-livekit-token, the deployed Edge Function): B (a genuine, already-joined
//      participant of R1 from Case 2) invokes generate-livekit-token for R1 and receives a real
//      token - its JWT payload is decoded (not verified/re-signed - this script has no access to
//      LIVEKIT_API_SECRET, by design) and asserted to carry `sub = B's user id` and
//      `video.room = R1's id`, proving the token is correctly scoped to the caller's own identity
//      and this specific room, not a generic/shared credential. C (never a participant of R1, and
//      confirmed denied in Case 2) invokes the same function for R1 and is rejected. A request
//      with no Authorization header at all is also rejected (401).
//   6. Cleans up every row/account it created.
//   7. Prints a pass/fail summary and exits non-zero if anything failed.
//
// What this script does NOT and CANNOT prove (see the report for the full honest accounting):
// actual audio/video capture, transmission, or rendering. That requires a real browser with
// camera/mic access and the extension actually loaded - Case 4's token decode proves the token is
// correctly minted and scoped, which is as far as token generation and room/presence mechanics go
// in this environment; it does not prove two browsers can actually see/hear each other.

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
const PASSWORD = `Verify-StudyRooms-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Mirrors scripts/verify-unlock-requests.mjs's/verify-rls.mjs's expectDenied/expectOk exactly
// (chaining `.single()` converts RLS's silent-filtering behavior into a hard error to assert on).
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
  const email = `study-room-test-${label}-${RUN_ID}@example.com`;
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

// Mirrors verify-unlock-requests.mjs's createGroupWithMembers exactly - `memberIds` includes the
// owner (group_memberships has no implicit "owner is a member" row; the group-visibility checks
// this task's migration adds join purely against group_memberships, same as unlock_requests').
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

// Mirrors studyRoomApi.ts's createRoom() insert exactly (same table/columns).
async function createRoomAs(client, ownerId, name) {
  return client.from("study_rooms").insert({ name, owner_user_id: ownerId }).select().single();
}

// Mirrors studyRoomApi.ts's joinRoom() participant insert exactly (same table/columns).
async function joinRoomAs(client, userId, roomId) {
  return client.from("study_room_participants").insert({ room_id: roomId, user_id: userId });
}

// Mirrors studyRoomApi.ts's leaveRoom() update exactly.
async function leaveRoomAs(client, userId, roomId) {
  return client
    .from("study_room_participants")
    .update({ left_at: new Date().toISOString() })
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .is("left_at", null);
}

// Decodes a JWT's payload WITHOUT verifying its signature - this script has no access to
// LIVEKIT_API_SECRET (by design; see the Edge Function's own header comment on why that secret
// must never leave the server), so signature verification isn't possible or necessary here. The
// point is only to confirm the SHAPE/CLAIMS of what generate-livekit-token minted (identity/room
// scoping), not to re-implement LiveKit's own verification.
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Not a well-formed JWT (expected 3 dot-separated parts)");
  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

// Waits (polling a predicate) up to `timeoutMs` for a Realtime event to have arrived - Realtime
// delivery is asynchronous over a WebSocket, so this can't be a synchronous assertion the way the
// direct-RLS cases above are.
async function waitFor(predicate, timeoutMs, pollIntervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return predicate();
}

async function cleanup(userIds, channels) {
  console.log("\nCleaning up test data...");
  for (const channel of channels) {
    try {
      await channel.unsubscribe();
    } catch {
      // best-effort
    }
  }
  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as every prior verify
  // script), so referencing rows must go before the rows/users they reference.
  await admin.from("study_room_participants").delete().in("user_id", userIds);
  const { data: ownedRooms } = await admin.from("study_rooms").select("id").in("owner_user_id", userIds);
  if (ownedRooms && ownedRooms.length > 0) {
    await admin
      .from("study_room_participants")
      .delete()
      .in("room_id", ownedRooms.map((r) => r.id));
  }
  await admin.from("study_rooms").delete().in("owner_user_id", userIds);
  // v2 Task 10's group_memberships_create_friendship_settings trigger auto-creates a
  // friendship_settings row for every ordered pair the moment members share a group (same note as
  // verify-unlock-requests.mjs's cleanup) - must be deleted before the users themselves.
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
    "Creating ephemeral test accounts (A = room owner, B/D = A's group-mates, C = different group)..."
  );
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userD = await createTestUser("d");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userD.id, userC.id];
  const channels = [];

  try {
    const clientA = await signInAs(userA.email);
    const clientB = await signInAs(userB.email);
    const clientD = await signInAs(userD.email);
    const clientC = await signInAs(userC.email);
    record("Setup: A, B, D, C signed in via anon-key client", true);

    await createGroupWithMembers(
      userA.id,
      [userA.id, userB.id, userD.id],
      `Verify Study Rooms G1 ${RUN_ID}`
    );
    await createGroupWithMembers(userC.id, [userC.id], `Verify Study Rooms G2 (unrelated) ${RUN_ID}`);
    record("Setup: A/B/D share group G1; C is alone in unrelated group G2", true);

    // --- Case 1: discovery (Part A SELECT fix) ---
    const room = await expectOk("Case 1: A creates study room R1", () =>
      createRoomAs(clientA, userA.id, `Verify Study Rooms R1 ${RUN_ID}`)
    );
    if (!room) throw new Error("Cannot continue without R1");

    await expectOk(
      "Case 1: B (group-mate, NOT yet joined) can discover/read R1 — the discovery-gap fix",
      () => clientB.from("study_rooms").select().eq("id", room.id).single()
    );
    await expectDenied(
      "Case 1: C (no shared group with A) cannot read R1 at all",
      () => clientC.from("study_rooms").select().eq("id", room.id).single()
    );

    // --- Case 2: join gate (Part A INSERT fix) ---
    await expectDenied(
      "Case 2: C (no shared group with A) cannot self-insert a participant row for R1",
      () => joinRoomAs(clientC, userC.id, room.id)
    );
    await expectOk("Case 2: B (group-mate) successfully joins R1", () =>
      joinRoomAs(clientB, userB.id, room.id)
    );

    // --- Case 3: presence via Supabase Realtime, live over a real WebSocket ---
    const receivedEvents = [];
    const presenceChannel = clientA
      .channel(`verify-study-room-presence-${RUN_ID}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "study_room_participants",
          filter: `room_id=eq.${room.id}`,
        },
        (payload) => receivedEvents.push(payload)
      );
    channels.push(presenceChannel);

    await new Promise((resolve, reject) => {
      presenceChannel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") resolve();
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reject(err ?? new Error(`Realtime subscribe failed: ${status}`));
        }
      });
    })
      .then(() => record("Case 3: A subscribed to R1's presence channel over Realtime", true))
      .catch((err) => record("Case 3: A subscribed to R1's presence channel over Realtime", false, err.message));

    // A "SUBSCRIBED" ack from the client confirms the WebSocket handshake completed, but the
    // server's replication stream can take a brief moment longer to start actually forwarding
    // change events for a just-created subscription - confirmed empirically against this live
    // project (the very first write immediately after "SUBSCRIBED" was sometimes missed, while
    // every later write on the same channel was reliably delivered). A short settle delay here
    // is a documented allowance for that startup race, not a workaround for flakiness in this
    // script's own logic - a real UI subscribing to presence would hit the same brief window.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await joinRoomAs(clientD, userD.id, room.id);
    const sawInsert = await waitFor(
      () => receivedEvents.some((e) => e.eventType === "INSERT" && e.new?.user_id === userD.id),
      10_000
    );
    record(
      "Case 3: A's live subscription received D's join (INSERT) within 10s",
      sawInsert,
      sawInsert ? undefined : `events so far: ${JSON.stringify(receivedEvents)}`
    );

    await leaveRoomAs(clientD, userD.id, room.id);
    const sawLeave = await waitFor(
      () =>
        receivedEvents.some(
          (e) => e.eventType === "UPDATE" && e.new?.user_id === userD.id && e.new?.left_at
        ),
      10_000
    );
    record(
      "Case 3: A's live subscription received D leaving (UPDATE, left_at set) within 10s — DoD's presence-update claim",
      sawLeave,
      sawLeave ? undefined : `events so far: ${JSON.stringify(receivedEvents)}`
    );

    // --- Case 4: generate-livekit-token (deployed Edge Function) ---
    const tokenResult = await expectOk(
      "Case 4: B (a genuine participant of R1) receives a token from generate-livekit-token",
      async () => {
        const { data, error } = await clientB.functions.invoke("generate-livekit-token", {
          body: { roomId: room.id },
        });
        if (error) return { data: null, error };
        if (!data?.token) return { data: null, error: { message: "No token in response" } };
        return { data, error: null };
      }
    );
    if (tokenResult?.token) {
      try {
        const payload = decodeJwtPayload(tokenResult.token);
        record(
          "Case 4: token's `sub` claim is B's own user id (scoped to caller's identity)",
          payload.sub === userB.id,
          `got sub=${payload.sub}`
        );
        record(
          "Case 4: token's `video.room` claim is R1's id (scoped to this room)",
          payload.video?.room === room.id,
          `got video.room=${payload.video?.room}`
        );
        const nowSeconds = Math.floor(Date.now() / 1000);
        record(
          "Case 4: token has a bounded, future expiry (short-lived, not indefinite)",
          typeof payload.exp === "number" && payload.exp > nowSeconds && payload.exp < nowSeconds + 6 * 60 * 60,
          `got exp=${payload.exp}, now=${nowSeconds}`
        );
      } catch (err) {
        record("Case 4: token is a well-formed, decodable JWT", false, err.message);
      }
    }

    const { error: cNoTokenError } = await clientC.functions.invoke("generate-livekit-token", {
      body: { roomId: room.id },
    });
    record(
      "Case 4: C (never a participant of R1) is rejected by generate-livekit-token",
      Boolean(cNoTokenError),
      cNoTokenError ? cNoTokenError.message : "expected an error, got none"
    );

    const anonNoSessionClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: noAuthError } = await anonNoSessionClient.functions.invoke("generate-livekit-token", {
      body: { roomId: room.id },
    });
    record(
      "Case 4: a request with no signed-in session is rejected by generate-livekit-token",
      Boolean(noAuthError),
      noAuthError ? noAuthError.message : "expected an error, got none"
    );
  } finally {
    await cleanup(userIds, channels);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Study rooms verification summary ===");
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
  console.error("verify-study-rooms.mjs crashed:", err);
  process.exit(1);
});
