// v2 Task 14: Producer Tags (Audio Nudges).
//
// Same fork-point precedent studyRoom.ts documents for itself: Tasks 6-9's *Api.ts files all
// define their task-owned backend types directly inside their own file rather than a separate
// domain/ module, but this task's plan entry explicitly names `domain/rooms/producerTag.ts` as its
// own deliverable ("`domain/rooms/producerTag.ts` (`ProducerTag`), backing `producer_tags` /
// `producer_tag_sends` tables") - since the plan is explicit about this one path, this file exists
// and is used, mirroring studyRoom.ts's own precedent. producer_tag_sends has no `id`/primary key
// column at all (see supabase/migrations/20260815000001_v2_accountability_schema.sql's own comment
// on why - "left as specified, not improvised") and no single canonical "one row" shape a UI ever
// renders on its own (a send is always rendered joined with its producer_tags row - see
// producerTagApi.ts's IncomingProducerTag/RoomProducerTagBroadcast), so unlike ProducerTag, no
// ProducerTagSend domain type is declared here - producerTagApi.ts owns those shapes directly,
// following the more common Task 6-9 precedent for exactly the send-side types.
//
// Camel-cased, mirroring every other *Api.ts/domain row-mapping convention in this codebase (e.g.
// studyRoom.ts's StudyRoom/RoomParticipant) even though the underlying Postgres columns are
// snake_case (see supabase/migrations/20260815000001_v2_accountability_schema.sql).
export interface ProducerTag {
  id: string;
  userId: string;
  // A Supabase Storage object path within the `producer-tags` bucket (e.g.
  // "<tagId>/clip.webm"), NOT a fully-qualified URL - the bucket is private (supabase/migrations/
  // 20260815000021_v2_producer_tags_storage_and_send_floor.sql), so there is no public URL to
  // store; producerTagApi.ts's downloadTagAudio(audioUrl) is what turns this path back into a
  // playable Blob via the Storage client SDK (which sends the caller's own auth token, so RLS
  // applies to the download exactly as it does to every other read in this codebase). Named
  // audioUrl (not audioPath) only because that's the column name the plan's schema block already
  // fixed (producer_tags.audio_url, supabase/migrations/20260815000001_...sql) - not a claim that
  // it's a URL a browser could fetch directly.
  audioUrl: string;
  durationMs: number;
  createdAt: string;
}
