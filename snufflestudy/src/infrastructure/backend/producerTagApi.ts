import { supabase } from "./supabaseClient";
import type { ProducerTag } from "../../domain/rooms/producerTag";

// v2 Task 14: Producer Tags (Audio Nudges).
//
// Message-passing scoping (mirrors Task 13's studyRoomApi.ts fix-round-1 precedent exactly - see
// that file's own header comment):
//
// uploadTag/sendToFriend/sendToRoom are plain CRUD-shaped writes with no DOM/live-callback
// coupling of their own, so - per this task's brief - they are called ONLY from
// src/background/messageRouter.ts (PRODUCER_TAG_UPLOAD/PRODUCER_TAG_SEND_TO_FRIEND/
// PRODUCER_TAG_SEND_TO_ROOM/PRODUCER_TAG_SENDS_FETCH/PRODUCER_TAG_FETCH_BY_ID - see
// src/shared/messages.ts), never imported directly by FriendGroupPanel.tsx/StudyRoomPanel.tsx -
// exactly like studyRoomApi.ts's createRoom/listRooms/leaveRoom/listParticipants.
//
// One genuine wrinkle uploadTag has that those four don't: its real parameter is a recorded audio
// Blob, and chrome.runtime.sendMessage's DEFAULT message serialization (this codebase has not set
// `message_serialization: "structured_clone"` in wxt.config.ts's manifest, which is Chrome-148+
// opt-in only) is plain JSON - it cannot carry a Blob at all. So uploadTag()'s OWN exported
// signature here still matches the plan's `uploadTag(blob: Blob): Promise<ProducerTag>` (plus a
// justified `durationMs` addition - see its own comment) and still runs only in the background,
// called only from messageRouter.ts - but the sidepanel side of that message case can't hand a raw
// Blob to sendMessage(). blobToBase64/blobFromBase64 below are the (pure, no-Supabase-coupling)
// serialization shim messageRouter.ts's PRODUCER_TAG_UPLOAD case and the panels use to bridge that
// gap, confirmed against Chrome's own current messaging docs rather than assumed to "just work"
// (developer.chrome.com/blog/structured-clone-messaging - Blob support over sendMessage is real,
// but opt-in and not enabled here).
//
// subscribeToRoomProducerTags and downloadTagAudio are the two functions genuinely called DIRECTLY
// from the sidepanel (StudyRoomPanel.tsx / FriendGroupPanel.tsx), for two independent reasons each
// mirroring studyRoomApi.ts's subscribeToPresence/joinRoom split:
//   - subscribeToRoomProducerTags's live-callback shape (a Supabase Realtime broadcast
//     subscription that keeps firing for as long as a Study Room panel is mounted) has no fit in
//     this codebase's one-shot request/response or alarm-driven-poll message-passing surface -
//     identical reasoning to subscribeToPresence.
//   - downloadTagAudio resolves to a Blob that must flow straight into a DOM `<audio>` element /
//     URL.createObjectURL() in the SAME component - and, per the paragraph above, a Blob can't
//     cross the sendMessage boundary at all under this codebase's current (default JSON)
//     serialization anyway, so routing it through messageRouter.ts is not just unnecessary but
//     actually impossible without the same base64 round trip uploadTag's caller already has to do
//     - not worth it for a read that has no side effect and is already RLS-gated identically to
//     every other read in this file.
//
// blobToBase64 is also called directly by the panels (to prepare the sendMessage payload) - it has
// zero Supabase coupling (a pure browser-API wrapper), so this is consistent with, not an
// exception to, the "panels don't import backend calls directly" rule above.

const PRODUCER_TAGS_BUCKET = "producer-tags";

// Sibling channel to studyRoomApi.ts's `study-room-presence-${roomId}` (Task 13's Postgres-Changes
// presence channel) - kept as a separate topic rather than reused, since this one is a PRIVATE,
// Broadcast-authorized channel (RLS on realtime.messages - see supabase/migrations/
// 20260815000021_v2_producer_tags_storage_and_send_floor.sql) and presence's is not; mixing the
// two authorization mechanisms on one topic is not a combination Supabase's own docs describe.
function roomBroadcastTopic(roomId: string): string {
  return `study-room-producer-tags:${roomId}`;
}

export interface RoomProducerTagBroadcast {
  tagId: string;
  roomId: string;
  senderUserId: string;
  sentAt: string;
}

// The row shape FriendGroupPanel.tsx actually needs to render+play an incoming tag: a
// producer_tag_sends row (this fetch is always the friend-recipient side - recipient_user_id is
// always the caller here, recipient_room_id always null, per the exactly-one-recipient CHECK
// constraint) joined with its producer_tags row for the audio path/duration. No ProducerTagSend
// domain type exists (see domain/rooms/producerTag.ts's own comment on why) - this shape is owned
// directly here, mirroring FriendNudge in nudgeApi.ts/UnlockRequest in unlockRequestApi.ts.
export interface IncomingProducerTag {
  tagId: string;
  senderUserId: string;
  sentAt: number;
  audioUrl: string;
  durationMs: number;
}

interface ProducerTagRow {
  id: string;
  user_id: string;
  audio_url: string;
  duration_ms: number;
  created_at: string;
}

function toProducerTag(row: ProducerTagRow): ProducerTag {
  return {
    id: row.id,
    userId: row.user_id,
    audioUrl: row.audio_url,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

// Mirrors friendGroupApi.ts's/studyRoomApi.ts's requireUserId()+throw convention - uploadTag/
// sendToFriend/sendToRoom are all explicit, infrequent user-initiated actions (record, then press
// "Send"), not a hot-path lifecycle transition, so paying getUser()'s extra round trip for a
// verified identity is fine here (same rationale those files' own copies of this comment give).
async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error("Not signed in.");
  }
  return data.user.id;
}

// Mirrors nudgeApi.ts's/unlockRequestApi.ts's checkAuth() exactly (same
// ok:false-means-the-check-itself-failed vs. ok:true/userId:null-means-cleanly-signed-out
// distinction) - queryIncomingSince below is the poll-side function that needs to tell a real
// failure apart from "nothing to do" so alarmHandlers.ts's friend-poll alarm doesn't advance its
// producer-tag cursor past a failure.
async function checkAuth(): Promise<{ ok: true; userId: string | null } | { ok: false }> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.error("Failed to read Supabase auth session", error);
      return { ok: false };
    }
    return { ok: true, userId: data.session?.user.id ?? null };
  } catch (err) {
    console.error("Failed to read Supabase auth session", err);
    return { ok: false };
  }
}

// Pure browser-API helpers (no Supabase coupling) bridging the chrome.runtime.sendMessage
// Blob-serialization gap described in this file's header comment. FileReader (not
// blob.arrayBuffer() + manual base64 encoding) is used because it's available in the sidepanel's
// real DOM context where this is called from and needs no manual chunking for a clip this short.
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // "data:<mimeType>;base64,<data>" - only the part after the comma is the actual base64
      // payload; the mimeType is already tracked/sent separately (see messageRouter.ts's
      // PRODUCER_TAG_UPLOAD case), so it's discarded here rather than re-parsed out of this string.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read recorded audio."));
    reader.readAsDataURL(blob);
  });
}

// The decode side, used only by messageRouter.ts's PRODUCER_TAG_UPLOAD case (background context -
// atob and Blob/Uint8Array are available on an MV3 service worker's global scope even though
// getUserMedia/MediaRecorder are not, so no DOM is needed for this half).
export function blobFromBase64(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// Inserts a producer_tags row, then uploads the recorded clip to Storage at
// '<tagId>/clip.webm' within the private producer-tags bucket (supabase/migrations/
// 20260815000021_v2_producer_tags_storage_and_send_floor.sql).
//
// tagId is generated CLIENT-SIDE (crypto.randomUUID()), not left to producer_tags.id's own
// gen_random_uuid() default - mirrors friendGroupApi.ts's createGroup() precedent for the exact
// same reason: the Storage INSERT policy needs to look up an EXISTING producer_tags row owned by
// the caller to authorize the upload, so the row must be inserted (with a known id) before the
// object upload is attempted, not after.
//
// durationMs is a deliberate, documented addition beyond the plan's literal
// `uploadTag(blob: Blob): Promise<ProducerTag>` signature (same category of justified deviation as
// studyRoomApi.ts's joinRoom returning `{ token }` beyond the plan's bare `joinRoom(roomId)`) -
// per this task's brief, duration_ms must be "derive[d] from the actual recorded blob/timing, not
// just assume the cap was hit". Decoding an audio Blob's true duration requires the Web Audio
// API's AudioContext, which does not exist in an MV3 background service worker (where this
// function runs) - so instead, the CALLER (a sidepanel panel, which has genuine DOM/timing access)
// reads audioRecorder.ts's own getLastRecordingDurationMs() - the actual wall-clock elapsed
// recording time, already clamped to the cap by that module - immediately after stopRecording()
// resolves, and passes it through here rather than this function re-deriving (or worse, assuming)
// it.
//
// On a failed upload, the just-inserted producer_tags row is deleted (best-effort) - a row with no
// backing audio object is a dead end (nothing can ever download it), and per the folder-per-tag
// Storage path convention, that tagId's folder can never be legitimately reused for a different
// upload attempt, so leaving the row behind would only ever be clutter, not a security concern.
export async function uploadTag(blob: Blob, durationMs: number): Promise<ProducerTag> {
  const userId = await requireUserId();
  const tagId = crypto.randomUUID();
  const path = `${tagId}/clip.webm`;

  const { data, error } = await supabase
    .from("producer_tags")
    .insert({
      id: tagId,
      user_id: userId,
      audio_url: path,
      duration_ms: Math.max(0, Math.round(durationMs)),
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to save this producer tag.");
  }

  const { error: uploadError } = await supabase.storage
    .from(PRODUCER_TAGS_BUCKET)
    .upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });
  if (uploadError) {
    await supabase.from("producer_tags").delete().eq("id", tagId);
    throw new Error(uploadError.message ?? "Failed to upload the recorded audio.");
  }

  return toProducerTag(data as ProducerTagRow);
}

// Sends an already-uploaded tag to a specific friend. The group-membership floor (the recipient
// must actually share a group with the sender) and the tag-ownership floor (the sender must
// actually own tagId) are both enforced entirely server-side by producer_tag_sends' INSERT policy
// (supabase/migrations/20260815000021_...sql) - this function never pre-checks either
// client-side, consistent with nudgeApi.ts's sendNudge() not pre-checking its own server-side
// gates (a malicious client could always bypass a client-side check with a raw REST call; only the
// server-side gate is load-bearing).
export async function sendToFriend(tagId: string, friendUserId: string): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from("producer_tag_sends").insert({
    tag_id: tagId,
    sender_user_id: userId,
    recipient_user_id: friendUserId,
    recipient_room_id: null,
  });
  if (error) {
    throw new Error(error.message ?? "Failed to send this tag.");
  }
}

// Sends an already-uploaded tag into a Study Room: inserts the producer_tag_sends row (gated by
// the same policy as sendToFriend - the room-membership floor and tag-ownership floor, see that
// migration), THEN broadcasts it live over Supabase Realtime so any currently-connected
// StudyRoomPanel (via subscribeToRoomProducerTags) hears about it within seconds rather than
// waiting for the next friend-poll alarm tick - per this task's DoD ("broadcast into an active
// Study Room, all current participants hear it"). The insert is the actual source of truth (any
// room member, present now or later, can always discover this send through the normal RLS-gated
// producer_tag_sends query path - there is no other delivery mechanism for room sends, per this
// task's Part D: friend delivery reuses the poll alarm, room delivery reuses Realtime, and ONLY
// Realtime); the broadcast is a best-effort, near-real-time enhancement on top of it. A broadcast
// failure (e.g. a transient WebSocket/REST issue) must not surface as sendToRoom() itself having
// failed - mirrors this codebase's established graceful-degradation posture (e.g. friendSync.ts's
// recordFriendStatusEvent) for a delivery path that's an enhancement, not the only path to
// eventual delivery.
export async function sendToRoom(tagId: string, roomId: string): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from("producer_tag_sends").insert({
    tag_id: tagId,
    sender_user_id: userId,
    recipient_user_id: null,
    recipient_room_id: roomId,
  });
  if (error) {
    throw new Error(error.message ?? "Failed to send this tag to the room.");
  }

  try {
    await broadcastProducerTagToRoom(roomId, { tagId, senderUserId: userId });
  } catch (err) {
    console.error("Failed to broadcast producer tag to room (the send itself already succeeded)", err);
  }
}

// A one-shot broadcast: opens a private channel scoped to this room's topic, sends over Realtime's
// REST broadcast path (channel.httpSend - available without first establishing/maintaining a
// WebSocket subscription, per current supabase-js docs; this runs in the background service
// worker via messageRouter.ts, so a short-lived REST call is a better fit than holding a
// persistent WebSocket open from a context MV3 can suspend at any time), then tears the channel
// down - mirrors studyRoomApi.ts's subscribeToPresence unsubscribe convention of calling
// supabase.removeChannel(...) rather than leaving it registered.
async function broadcastProducerTagToRoom(
  roomId: string,
  payload: { tagId: string; senderUserId: string }
): Promise<void> {
  const channel = supabase.channel(roomBroadcastTopic(roomId), { config: { private: true } });
  try {
    const result = await channel.httpSend("producer-tag", {
      tagId: payload.tagId,
      roomId,
      senderUserId: payload.senderUserId,
      sentAt: new Date().toISOString(),
    } satisfies RoomProducerTagBroadcast);
    if (!result.success) {
      throw new Error(result.error);
    }
  } finally {
    supabase.removeChannel(channel);
  }
}

// Called directly from StudyRoomPanel.tsx (see this file's header comment) while a room is
// joined - subscribes to this room's producer-tag broadcast topic and invokes onTag for every
// live broadcast received. Mirrors studyRoomApi.ts's subscribeToPresence return-an-unsubscriber
// shape.
export function subscribeToRoomProducerTags(
  roomId: string,
  onTag: (event: RoomProducerTagBroadcast) => void
): () => void {
  const channel = supabase
    .channel(roomBroadcastTopic(roomId), { config: { private: true } })
    .on("broadcast", { event: "producer-tag" }, (message) => {
      onTag(message.payload as RoomProducerTagBroadcast);
    })
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Called directly from FriendGroupPanel.tsx/StudyRoomPanel.tsx (see this file's header comment) -
// downloads the actual audio Blob for a tag via the Storage client SDK, which sends the caller's
// own auth token, so the Storage SELECT policy (supabase/migrations/
// 20260815000021_...sql - mirrors producer_tags' own recipient-visibility policy exactly) applies
// to this exactly as it would to any other read in this codebase. audioUrl is the Storage object
// path (producer_tags.audio_url / ProducerTag.audioUrl / IncomingProducerTag.audioUrl /
// RoomProducerTagBroadcast's own fetched tag - see downstream callers), not a fetchable URL on its
// own - the bucket is private, so there is no public URL for it to be.
export async function downloadTagAudio(audioUrl: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from(PRODUCER_TAGS_BUCKET).download(audioUrl);
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to download this recording.");
  }
  return data;
}

// Looks up a single producer_tags row by id - used by StudyRoomPanel.tsx (via messageRouter.ts's
// PRODUCER_TAG_FETCH_BY_ID, a plain CRUD read with no DOM coupling of its own) once a live
// broadcast (subscribeToRoomProducerTags above) names a tagId, to resolve the audioUrl/durationMs
// needed to actually play it - the broadcast payload deliberately carries only tagId/roomId/
// senderUserId/sentAt (see RoomProducerTagBroadcast), not the audio path itself, so this read
// stays gated by producer_tags' own RLS (recipients-only) rather than trusting whatever a channel
// payload happens to contain.
export async function fetchProducerTagById(tagId: string): Promise<ProducerTag | null> {
  const { data, error } = await supabase.from("producer_tags").select().eq("id", tagId).maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data ? toProducerTag(data as ProducerTagRow) : null;
}

// Shared implementation behind fetchIncomingProducerTagSends/pollIncomingProducerTagSends below -
// same split/rationale as nudgeApi.ts's queryNudgesSince: `ok` distinguishes "the query itself
// failed" from "it ran cleanly and found nothing new", which only matters to the poll-side caller
// (alarmHandlers.ts's friend-poll alarm, which must not advance its persisted producer-tag cursor
// past a failure).
//
// Filtered to recipient_user_id = auth.uid() - this is deliberately the FRIEND-delivery side only
// (per this task's Part D: friend delivery reuses the poll alarm, room delivery reuses Realtime,
// not this poll). A room send always has recipient_user_id null (the exactly-one-recipient CHECK
// constraint, 20260815000021), so this filter alone already excludes every room send with no
// additional logic needed.
//
// producer_tags(audio_url, duration_ms) is an embedded-resource select via the tag_id foreign key
// (a narrowed column select, per this codebase's convention) - RLS still applies to the embedded
// rows exactly as it would to a separate query (producer_tags' own recipient SELECT policy already
// grants this), so this is not a widening of what the caller can see, just one fewer round trip.
async function queryIncomingSince(
  sinceTimestamp: number
): Promise<{ ok: boolean; sends: IncomingProducerTag[] }> {
  try {
    const auth = await checkAuth();
    if (!auth.ok) return { ok: false, sends: [] }; // The auth check itself failed - a real failure.
    if (!auth.userId) return { ok: true, sends: [] }; // Cleanly signed out - nothing to fetch, no-op.

    const { data, error } = await supabase
      .from("producer_tag_sends")
      .select("tag_id, sender_user_id, sent_at, producer_tags(audio_url, duration_ms)")
      .eq("recipient_user_id", auth.userId)
      .gt("sent_at", new Date(sinceTimestamp).toISOString())
      .order("sent_at", { ascending: true });
    if (error || !data) {
      console.error("Failed to fetch incoming producer tags", error);
      return { ok: false, sends: [] };
    }

    const sends: IncomingProducerTag[] = [];
    for (const row of data as unknown as Array<{
      tag_id: string;
      sender_user_id: string;
      sent_at: string;
      producer_tags: { audio_url: string; duration_ms: number } | null;
    }>) {
      // The joined producer_tags row can only be null if the tag itself was deleted after being
      // sent (not a path this codebase's own client code takes, but not impossible via a raw
      // REST call) - skipped rather than surfaced as a broken entry with nothing playable.
      if (!row.producer_tags) continue;
      sends.push({
        tagId: row.tag_id,
        senderUserId: row.sender_user_id,
        sentAt: new Date(row.sent_at).getTime(),
        audioUrl: row.producer_tags.audio_url,
        durationMs: row.producer_tags.duration_ms,
      });
    }
    return { ok: true, sends };
  } catch (err) {
    console.error("Failed to fetch incoming producer tags", err);
    return { ok: false, sends: [] };
  }
}

// On-demand fetch for FriendGroupPanel.tsx (via messageRouter.ts's PRODUCER_TAG_SENDS_FETCH) -
// collapses the ok/sends distinction into a plain array, mirroring fetchIncomingNudges/
// fetchRelevantUnlockRequests's identical contract.
export async function fetchIncomingProducerTagSends(sinceTimestamp: number): Promise<IncomingProducerTag[]> {
  const result = await queryIncomingSince(sinceTimestamp);
  return result.sends;
}

// Poll-specific variant for alarmHandlers.ts's friend-poll alarm - mirrors pollIncomingNudges'/
// pollRelevantUnlockRequests' discriminated result exactly, so the alarm only advances its
// persisted "last checked for producer tags" cursor (friendPollState.ts) on a confirmed successful
// poll, leaving it untouched on failure so the next tick retries the same window instead of
// silently and permanently dropping a friend-sent tag's notification.
export async function pollIncomingProducerTagSends(
  sinceTimestamp: number
): Promise<{ ok: true; sends: IncomingProducerTag[] } | { ok: false }> {
  const result = await queryIncomingSince(sinceTimestamp);
  return result.ok ? { ok: true, sends: result.sends } : { ok: false };
}
