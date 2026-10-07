export interface ProducerTag {
  id: string;
  userId: string;
  // A Supabase Storage object path within the `producer-tags` bucket (e.g. "<tagId>/clip.webm"),
  // NOT a fully-qualified URL - the bucket is private, so there is no public URL to store;
  // producerTagApi.ts's downloadTagAudio(audioUrl) turns this path back into a playable Blob via
  // the Storage client SDK (which sends the caller's own auth token, so RLS applies to the
  // download exactly as it does to every other read in this codebase). Named audioUrl (not
  // audioPath) only because that's the underlying column name - not a claim that it's a URL a
  // browser could fetch directly.
  audioUrl: string;
  durationMs: number;
  createdAt: string;
}
