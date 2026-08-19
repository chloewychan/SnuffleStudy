// Live end-to-end proof for Task 14's Definition of Done ("a recorded tag can be sent to a
// specific friend (arrives via the same delivery path as a nudge) or broadcast into an active
// Study Room (all current participants hear it)") AND for this task's own explicit "verify, don't
// assume" instructions on the RLS/Storage surface it introduces. A mocked unit test (see
// src/infrastructure/backend/producerTagApi.test.ts) can only prove uploadTag/sendToFriend/
// sendToRoom call the right table/columns/Storage calls - it can't prove the live database's RLS
// policies and Storage bucket policies (supabase/migrations/
// 20260815000021_v2_producer_tags_storage_and_send_floor.sql) actually gate access the way they
// claim to, or that a Realtime Broadcast actually fires over a real WebSocket. This script proves
// all of that against the live project.
//
// Standalone Node script (same style/conventions as scripts/verify-study-rooms.mjs for the
// Realtime-testing approach, and scripts/verify-nudges.mjs for the friend-delivery-adjacent
// account/group setup patterns) - reads .env via dotenv/config, not part of `npm test`. Run
// directly: node scripts/verify-producer-tags.mjs
//
// Accounts: A (tag owner/sender), B (A's group-mate - the friend recipient AND a room member), D
// (a second room member - the live-broadcast listener), C (a stranger who shares no group with A
// anywhere, and is never a room member). Group G1 = {A, B, D}; C is alone in an unrelated G2.
// Room R1 is owned by A, with B and D joined as participants; C never joins it.
//
// What it does (case numbers referenced in the report):
//   1. A uploads tag1 (producer_tags row + Storage object at "<tagId>/clip.webm") - confirms both
//      the row and the object exist and are correctly linked (case 1: upload).
//   2. Ownership floor: C (owns nothing) cannot insert a producer_tag_sends row for A's tag1 -
//      confirms a stranger can't re-share someone else's tag by naming themselves sender.
//   3. Group floor: A cannot send tag1 to C (no shared group) - confirms the group-membership
//      floor on producer_tag_sends' INSERT policy.
//   4. A sends tag1 to B (friend delivery) - confirms B (and ONLY B) can read the producer_tags
//      row AND download the Storage object; C (unrelated) can do neither (case 2: friend
//      delivery + recipient-only visibility).
//   5. Room floor: C (not a participant/owner of R1) cannot send a NEW tag to R1.
//   6. A uploads tag2 and sends it to room R1 - confirms B and D (room members) can read the row
//      + download the object, C cannot do either - AND confirms a live Realtime Broadcast on the
//      private `study-room-producer-tags:<roomId>` topic actually fires and is received by D's
//      subscribed client within a few seconds, while C's attempt to even SUBSCRIBE to that same
//      private topic is rejected outright (case 3: room delivery + live broadcast).
//   7. producer_tag_sends UPDATE and DELETE are both genuinely denied for a normal authenticated
//      client (B, a legitimate recipient) - live-tested, not assumed (case 4).
//   8. The storage bucket is genuinely private: a signed-out (anon-role, no session) client's
//      download attempt is denied outright (case 5).
//   9. Extra depth beyond the brief's five numbered cases, all proactive fixes this task's own
//      migration added: the exactly-one-recipient CHECK constraint rejects a row with both (or
//      neither) recipient column set; producer_tags' immutable-columns trigger rejects A trying
//      to rewrite tag1's audio_url/duration_ms after it was already sent; the Storage INSERT
//      policy rejects A trying to upload into a DIFFERENT tag's folder; the Storage layer denies
//      an upsert-style overwrite of an already-uploaded object (no UPDATE policy).
//  10. Cleans up every row, Storage object, and account it created.
//  11. Prints a pass/fail summary and exits non-zero if anything failed.

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

const BUCKET = "producer-tags";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = Date.now();
// Ephemeral, discarded at cleanup - never reused, never printed.
const PASSWORD = `Verify-ProducerTags-${crypto.randomUUID()}!`;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Mirrors scripts/verify-study-rooms.mjs's expectDenied/expectOk exactly (chaining `.single()`
// converts RLS's silent-filtering behavior into a hard error to assert on).
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
  const email = `producer-tags-test-${label}-${RUN_ID}@example.com`;
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

function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Mirrors scripts/verify-study-rooms.mjs's/verify-nudges.mjs's createGroupWithMembers exactly.
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

// Mirrors producerTagApi.ts's uploadTag() exactly: a client-generated id, insert first, THEN
// upload to Storage at "<tagId>/clip.webm" - this script exercises the real two-step flow (not a
// simplified version of it) so it's actually proving the same ordering the real client code
// depends on for the Storage INSERT policy's ownership lookup to work at all.
async function uploadTagAs(client, ownerId, label) {
  const tagId = crypto.randomUUID();
  const path = `${tagId}/clip.webm`;
  const { error: insertErr } = await client
    .from("producer_tags")
    .insert({ id: tagId, user_id: ownerId, audio_url: path, duration_ms: 3000 });
  if (insertErr) throw new Error(`[${label}] Failed to insert producer_tags row: ${insertErr.message}`);

  const { error: uploadErr } = await client.storage
    .from(BUCKET)
    .upload(path, Buffer.from(`fake-audio-bytes-${label}`), { contentType: "audio/webm", upsert: false });
  if (uploadErr) throw new Error(`[${label}] Failed to upload audio object: ${uploadErr.message}`);

  return { tagId, path };
}

function sendToFriendAs(client, senderId, tagId, friendUserId) {
  return client
    .from("producer_tag_sends")
    .insert({ tag_id: tagId, sender_user_id: senderId, recipient_user_id: friendUserId, recipient_room_id: null });
}

function sendToRoomAs(client, senderId, tagId, roomId) {
  return client
    .from("producer_tag_sends")
    .insert({ tag_id: tagId, sender_user_id: senderId, recipient_user_id: null, recipient_room_id: roomId });
}

// Mirrors producerTagApi.ts's sendToRoom()'s SECOND step exactly (see that file): after the
// producer_tag_sends row insert above succeeds, the real client also broadcasts a one-shot Realtime
// message over the room's private topic via channel.httpSend, so a live-subscribed StudyRoomPanel
// hears about it within seconds instead of waiting for the next poll. `sendToRoomAs` above only
// covers the row insert (proving the producer_tag_sends INSERT floor); without this second call,
// nothing in this script would ever actually exercise the realtime.messages Broadcast INSERT policy
// or produce a message for a subscriber to receive - Case 3's own live-broadcast assertion below
// would be unwinnable regardless of how correct the RLS is. Not exercising this was a real gap in
// this script's first draft, found the same way the RLS recursion bug was: by actually running it
// and noticing the broadcast assertion could never pass, not by inspection.
//
// Returns a Supabase-style {data, error} pair (rather than resolving void/throwing) specifically
// so this fits expectOk/expectDenied's shared contract unchanged, same as every other helper above.
async function broadcastToRoomAs(client, roomId, tagId, senderUserId) {
  const channel = client.channel(`study-room-producer-tags:${roomId}`, { config: { private: true } });
  try {
    const result = await channel.httpSend("producer-tag", {
      tagId,
      roomId,
      senderUserId,
      sentAt: new Date().toISOString(),
    });
    return result.success
      ? { data: true, error: null }
      : { data: null, error: { message: `status ${result.status}: ${result.error}` } };
  } finally {
    client.removeChannel(channel);
  }
}

async function createRoomAs(client, ownerId, name) {
  return client.from("study_rooms").insert({ name, owner_user_id: ownerId }).select().single();
}

function joinRoomAs(client, userId, roomId) {
  return client.from("study_room_participants").insert({ room_id: roomId, user_id: userId });
}

async function waitFor(predicate, timeoutMs, pollIntervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return predicate();
}

async function cleanup(userIds, roomIds, tagIds, channels) {
  console.log("\nCleaning up test data...");
  for (const channel of channels) {
    try {
      await channel.unsubscribe();
      await admin.removeChannel(channel);
    } catch {
      // best-effort
    }
  }

  // Storage objects first (no FK, but tidiness matters - these are real files in the bucket).
  for (const tagId of tagIds) {
    try {
      await admin.storage.from(BUCKET).remove([`${tagId}/clip.webm`]);
    } catch {
      // best-effort
    }
  }

  // Dependency order matters: FKs have no ON DELETE CASCADE (same note as every prior verify
  // script), so referencing rows must go before the rows/users they reference.
  await admin.from("producer_tag_sends").delete().in("tag_id", tagIds);
  await admin.from("producer_tags").delete().in("id", tagIds);
  await admin.from("study_room_participants").delete().in("room_id", roomIds);
  await admin.from("study_rooms").delete().in("id", roomIds);
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
    "Creating ephemeral test accounts (A = owner/sender, B = friend+room member, D = room member, C = stranger)..."
  );
  const userA = await createTestUser("a");
  const userB = await createTestUser("b");
  const userD = await createTestUser("d");
  const userC = await createTestUser("c");
  const userIds = [userA.id, userB.id, userD.id, userC.id];
  const roomIds = [];
  const tagIds = [];
  const channels = [];

  try {
    const clientA = await signInAs(userA.email);
    const clientB = await signInAs(userB.email);
    const clientD = await signInAs(userD.email);
    const clientC = await signInAs(userC.email);
    record("Setup: A, B, D, C signed in via anon-key client", true);

    await createGroupWithMembers(userA.id, [userA.id, userB.id, userD.id], `Verify Producer Tags G1 ${RUN_ID}`);
    await createGroupWithMembers(userC.id, [userC.id], `Verify Producer Tags G2 (unrelated) ${RUN_ID}`);
    record("Setup: A/B/D share group G1; C is alone in unrelated group G2", true);

    const room = await expectOk("Setup: A creates study room R1", () =>
      createRoomAs(clientA, userA.id, `Verify Producer Tags R1 ${RUN_ID}`)
    );
    if (!room) throw new Error("Cannot continue without R1");
    roomIds.push(room.id);
    await expectOk("Setup: B joins R1", () => joinRoomAs(clientB, userB.id, room.id));
    await expectOk("Setup: D joins R1", () => joinRoomAs(clientD, userD.id, room.id));

    // --- Case 1: upload ---
    const tag1 = await (async () => {
      try {
        const result = await uploadTagAs(clientA, userA.id, "tag1");
        record("Case 1: A uploads tag1 (producer_tags row + Storage object)", true);
        return result;
      } catch (err) {
        record("Case 1: A uploads tag1 (producer_tags row + Storage object)", false, err.message);
        return null;
      }
    })();
    if (!tag1) throw new Error("Cannot continue without tag1");
    tagIds.push(tag1.tagId);

    await expectOk("Case 1: the producer_tags row for tag1 is readable by its owner (A)", () =>
      clientA.from("producer_tags").select().eq("id", tag1.tagId).single()
    );
    const objectList = await expectOk("Case 1: the Storage object for tag1 exists in the bucket", async () => {
      const { data, error } = await admin.storage.from(BUCKET).list(tag1.tagId);
      if (error) return { data: null, error };
      const found = (data ?? []).some((f) => f.name === "clip.webm");
      return found ? { data: [true], error: null } : { data: null, error: { message: "clip.webm not found" } };
    });
    void objectList;

    // --- Case: ownership floor (C doesn't own tag1) ---
    await expectDenied("Ownership floor: C cannot insert a producer_tag_sends row for A's tag1 (C doesn't own it)", () =>
      sendToFriendAs(clientC, userC.id, tag1.tagId, userC.id)
    );

    // --- Case: group floor (A and C share no group) ---
    await expectDenied("Group floor: A cannot send tag1 to C (no shared group)", () =>
      sendToFriendAs(clientA, userA.id, tag1.tagId, userC.id)
    );

    // --- Case 2: friend delivery + recipient-only visibility ---
    await expectOk("Case 2: A sends tag1 to B (friend delivery)", () =>
      sendToFriendAs(clientA, userA.id, tag1.tagId, userB.id)
    );
    await expectOk("Case 2: B (the recipient) can read tag1's producer_tags row", () =>
      clientB.from("producer_tags").select().eq("id", tag1.tagId).single()
    );
    await expectOk("Case 2: B (the recipient) can download tag1's Storage object", () =>
      clientB.storage.from(BUCKET).download(tag1.path)
    );
    await expectDenied("Case 2: C (unrelated third party) cannot read tag1's producer_tags row", () =>
      clientC.from("producer_tags").select().eq("id", tag1.tagId).single()
    );
    await expectDenied("Case 2: C (unrelated third party) cannot download tag1's Storage object", () =>
      clientC.storage.from(BUCKET).download(tag1.path)
    );

    // --- Case: room floor (C is not a participant/owner of R1) ---
    const tagForRoomFloorTest = await uploadTagAs(clientC, userC.id, "tag-c-roomfloor");
    tagIds.push(tagForRoomFloorTest.tagId);
    await expectDenied("Room floor: C cannot send their own tag to R1 (not a participant/owner)", () =>
      sendToRoomAs(clientC, userC.id, tagForRoomFloorTest.tagId, room.id)
    );

    // --- Case 3: room delivery + live Realtime broadcast ---
    const tag2 = await uploadTagAs(clientA, userA.id, "tag2");
    tagIds.push(tag2.tagId);

    const topic = `study-room-producer-tags:${room.id}`;
    const receivedByD = [];
    const dChannel = clientD.channel(topic, { config: { private: true } }).on(
      "broadcast",
      { event: "producer-tag" },
      (msg) => receivedByD.push(msg.payload)
    );
    channels.push(dChannel);
    await new Promise((resolve, reject) => {
      dChannel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") resolve();
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reject(err ?? new Error(`Realtime subscribe failed: ${status}`));
        }
      });
    })
      .then(() => record("Case 3: D (a room member) subscribes to R1's private producer-tag broadcast topic", true))
      .catch((err) =>
        record("Case 3: D (a room member) subscribes to R1's private producer-tag broadcast topic", false, err.message)
      );

    // C is NOT a member of R1 - subscribing to the same private topic must be rejected outright
    // by the Realtime Authorization policy (realtime.messages' SELECT policy), not merely receive
    // nothing.
    let cSubscribeRejected = false;
    let cSubscribeStatus = null;
    const cChannel = clientC.channel(topic, { config: { private: true } }).on("broadcast", { event: "producer-tag" }, () => {});
    channels.push(cChannel);
    await new Promise((resolve) => {
      cChannel.subscribe((status) => {
        cSubscribeStatus = status;
        if (status === "SUBSCRIBED") {
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          cSubscribeRejected = true;
          resolve();
        }
      });
      // Safety timeout in case the client library never calls back with a terminal status.
      setTimeout(resolve, 5000);
    });
    record(
      "Case 3: C (not a room member) is rejected when attempting to subscribe to R1's private broadcast topic",
      cSubscribeRejected,
      `final status: ${cSubscribeStatus}`
    );

    await new Promise((resolve) => setTimeout(resolve, 1000)); // settle window, same as verify-study-rooms.mjs

    await expectOk("Case 3: A sends tag2 to room R1", () => sendToRoomAs(clientA, userA.id, tag2.tagId, room.id));

    // A is R1's OWNER but was never added to study_room_participants (nothing in this codebase
    // auto-joins a room's creator - studyRoomApi.ts's createRoom() only inserts the study_rooms
    // row; joining is a separate, explicit joinRoom() call B/D both made above and A never did).
    // Part A.2's producer_tag_sends INSERT floor explicitly treats the owner as equivalent to a
    // participant for targeting a room - this call proves the sibling realtime.messages Broadcast
    // INSERT policy grants A (owner-but-not-participant) that same floor, not just a narrower one.
    await expectOk("Case 3: A (room owner, not a participant) broadcasts tag2 over R1's live topic", () =>
      broadcastToRoomAs(clientA, room.id, tag2.tagId, userA.id)
    );

    const sawBroadcast = await waitFor(
      () => receivedByD.some((p) => p.tagId === tag2.tagId && p.roomId === room.id),
      10_000
    );
    record(
      "Case 3: D's live subscription received the producer-tag broadcast within 10s",
      sawBroadcast,
      sawBroadcast ? undefined : `received so far: ${JSON.stringify(receivedByD)}`
    );

    await expectOk("Case 3: B (room member) can read tag2's producer_tags row", () =>
      clientB.from("producer_tags").select().eq("id", tag2.tagId).single()
    );
    await expectOk("Case 3: D (room member) can download tag2's Storage object", () =>
      clientD.storage.from(BUCKET).download(tag2.path)
    );
    await expectDenied("Case 3: C (not a room member) cannot read tag2's producer_tags row", () =>
      clientC.from("producer_tags").select().eq("id", tag2.tagId).single()
    );
    await expectDenied("Case 3: C (not a room member) cannot download tag2's Storage object", () =>
      clientC.storage.from(BUCKET).download(tag2.path)
    );

    // --- Case 4: producer_tag_sends UPDATE/DELETE genuinely denied ---
    await expectDenied(
      "Case 4: B (a legitimate recipient) cannot UPDATE the producer_tag_sends row for tag1",
      () =>
        clientB
          .from("producer_tag_sends")
          .update({ sender_user_id: userB.id })
          .eq("tag_id", tag1.tagId)
          .select()
    );
    await expectDenied(
      "Case 4: B (a legitimate recipient) cannot DELETE the producer_tag_sends row for tag1",
      () => clientB.from("producer_tag_sends").delete().eq("tag_id", tag1.tagId).select()
    );

    // --- Case 5: the Storage bucket is genuinely private ---
    const signedOutClient = anonClient();
    await expectDenied(
      "Case 5: a signed-out (anon-role, no session) client cannot download tag1's Storage object",
      () => signedOutClient.storage.from(BUCKET).download(tag1.path)
    );

    // --- Extra depth: proactive fixes this task's own migration added ---
    await expectDenied(
      "Extra: producer_tag_sends' exactly-one-recipient CHECK constraint rejects BOTH recipient columns set",
      () =>
        admin
          .from("producer_tag_sends")
          .insert({ tag_id: tag1.tagId, sender_user_id: userA.id, recipient_user_id: userB.id, recipient_room_id: room.id })
          .select()
    );
    await expectDenied(
      "Extra: producer_tag_sends' exactly-one-recipient CHECK constraint rejects NEITHER recipient column set",
      () =>
        admin
          .from("producer_tag_sends")
          .insert({ tag_id: tag1.tagId, sender_user_id: userA.id, recipient_user_id: null, recipient_room_id: null })
          .select()
    );
    await expectDenied(
      "Extra: producer_tags' immutable-columns trigger rejects A rewriting tag1's audio_url after it was sent",
      () =>
        clientA
          .from("producer_tags")
          .update({ audio_url: `${tag2.tagId}/clip.webm` })
          .eq("id", tag1.tagId)
          .select()
    );
    await expectDenied(
      "Extra: Storage INSERT policy rejects A uploading into a DIFFERENT tag's folder (tag2, owned by A, but not the id this upload names as its own row)",
      async () => {
        const strayId = crypto.randomUUID();
        return clientA.storage
          .from(BUCKET)
          .upload(`${strayId}/clip.webm`, Buffer.from("stray-bytes"), { contentType: "audio/webm" });
      }
    );
    await expectDenied(
      "Extra: Storage layer denies an upsert-style overwrite of tag1's already-uploaded object (no UPDATE policy)",
      () =>
        clientA.storage
          .from(BUCKET)
          .upload(tag1.path, Buffer.from("overwritten-bytes"), { contentType: "audio/webm", upsert: true })
    );
  } finally {
    await cleanup(userIds, roomIds, tagIds, channels);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Producer tags verification summary ===");
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
  console.error("verify-producer-tags.mjs crashed:", err);
  process.exit(1);
});
