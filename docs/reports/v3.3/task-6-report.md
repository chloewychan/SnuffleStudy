# V3.3 Task 6 report: Archive study rooms (soft delete)

**Branch:** `v3.3` (already checked out). Work started from Tasks 1/2/3/5 already landed (`c472385`, `e94eab7`, `0ac177e`, `bb20fd3`).

**Note on how this task was executed:** the subagent originally dispatched for this task implemented the full code change, wrote the migration, and wrote (but had not yet run) a thorough live-DB negative-case verification script before its session was cut off mid-verification by a session-limit error — not a real blocker in the task itself. The orchestrating session resumed from that exact point: reviewed the already-written diff and migration for correctness, ran the verification script the subagent had already written, cleaned up a leftover test-data gap in that script's own cleanup routine, ran the full test/compile suite, and completed the report and commit. No implementation code was rewritten; the subagent's diff was correct as found.

## Pre-flight verification against the live repo (done by the original subagent, reviewed here)

The migration's own header comment documents this directly: `study_rooms` (added in `20260815000001_v2_accountability_schema.sql`) had no UPDATE policy at all before this task — only `"owner can create study rooms"` (INSERT) and `"owner group-mates and participants can read study rooms"` (SELECT, widened by `20260815000019`). Confirmed by re-checking `pg_policies` against the live DB directly (see Verification below) before treating that claim as settled. Also confirmed directly against `supabase/migrations/*.sql`: no `study_rooms` row is ever hard-deleted anywhere in this schema, and `producer_tag_sends.recipient_room_id` really does reference `study_rooms(id)` with no `ON DELETE CASCADE` — the FK justification the plan and migration both give for soft-delete-over-hard-delete holds.

## What was built

- **Migration** `supabase/migrations/20260815000033_v3.3_archive_study_rooms.sql` (next sequential number after `20260815000032`): adds nullable `archived_at timestamptz` to `study_rooms`, plus the `"owner can archive their own room"` UPDATE policy (`using`/`with check` both `owner_user_id = auth.uid()`), exactly per the plan.
- **`studyRoomApi.ts`**: `listRooms()` gained `.is("archived_at", null)`; new `archiveRoom(roomId)` does `requireUserId()` then `.update({ archived_at: <now> }).eq("id", roomId).eq("owner_user_id", userId)`, throwing on a Postgres error — same convention as `createRoom`/`leaveRoom`. The client-side `owner_user_id` filter is belt-and-suspenders alongside the RLS policy, matching this file's existing style of keeping intent legible without relying on the reader to already know the policy exists.
- **`shared/messages.ts`**: new `{ type: "STUDY_ROOM_ARCHIVE"; payload: { roomId: string } }`.
- **`messageRouter.ts`**: new `STUDY_ROOM_ARCHIVE` case, thin pass-through to `archiveRoom`, same convention as `STUDY_ROOM_LEAVE` (throws propagate to the outer `handleMessage` catch, which turns them into `{ ok: false }`).
- **`StudyRoomPanel.tsx`**: an "Archive this room" button shown only when `room.ownerUserId === selfUserId`, with its own per-room `archivingId`/`archiveError` state (mirroring the existing per-room `joining` pattern so archiving one room doesn't disable every other room's buttons); on success, optimistically removes the room from the local `rooms` list rather than waiting on a full re-fetch, matching `handleCreateRoom`'s existing convention.
- **Tests**: `studyRoomApi.test.ts` gained three new cases (`archiveRoom` sets `archived_at` scoped to the caller; throws when not signed in without touching the DB; throws with the Postgres error message on failure) plus an assertion that `listRooms()` now calls `.is("archived_at", null)`. `StudyRoomPanel.test.tsx` gained coverage for the owner-only button visibility, the archive action, and its error path.

## What was verified

- **`node scripts/apply-migrations.mjs`** (live dev DB, via `snufflestudy/.env`): applied cleanly, recorded in `_migrations`.
- **Direct `pg` query against the live DB** (run by the orchestrator, not just `verify-schema.mjs`'s general dump): confirmed `study_rooms` now has `archived_at` and exactly three policies — the two pre-existing ones plus `"owner can archive their own room"` (UPDATE).
- **`npx vitest run`** (full suite): 86 files, **846 tests, all passed** (up from 839 before this task — 7 new tests).
- **`npm run compile`** (`tsc --noEmit`): clean.
- **Live-DB negative-case verification, actually run** (this is the part the interrupted subagent had written but not yet executed): a two-account (plus a third, unrelated-stranger account) script against the real Supabase project — not code inspection alone. All 14 checks passed:
  - A group-mate's `archiveRoom()`-shaped call against a room she doesn't own has no effect (`archived_at` stays null).
  - The actual RLS boundary: a non-owner's UPDATE on the room, explicitly filtered by the room's *true* owner id (the only way to make the `using (owner_user_id = auth.uid())` clause — not the client-side filter — the deciding factor), is denied by Postgres itself, both for a group-mate and for a fully unrelated stranger.
  - The real owner's archive call succeeds; the room disappears from a `listRooms()`-shaped query for both the owner and a group-mate; the row is still directly readable by id (a soft delete, not erased).
  - A `producer_tag_sends` row referencing the archived room is untouched and still readable by a real room participant after archiving — the DoD's explicit Producer Tag history claim, verified against real rows, not just "no `ON DELETE CASCADE` exists" reasoning.
  - The script's own cleanup left one test user (`archive-room-test-a-*`) undeletable, because the script created `producer_tags`/`producer_tag_sends` rows for the Producer Tag history check but never deleted them in its `cleanup()` function — the FK from those tables back to the user blocked `auth.admin.deleteUser`. Found via a direct FK-column scan against the live DB, fixed by manually deleting the three orphaned rows (one `study_rooms`, one `producer_tags`, one `producer_tag_sends`) and then the user; re-checked afterward and no `archive-room-test-*` users remain in the live DB. This was a gap in the throwaway verification script's own hygiene, not in the actual `archiveRoom`/migration code — none of the leftover rows were reachable through any RLS-gated path other than by the owning test account itself, so nothing was ever cross-account-visible.
  - The verification script itself was **not** committed — it's ad hoc, run once from `snufflestudy/scripts/` and deleted afterward, matching its own header's stated intent ("not added to `snufflestudy/scripts/` because Task 6's plan Deliverables section doesn't list a new verify script as an owned artifact").

## What's still open

Nothing within Task 6's own scope. `docs/Multi_Step_Plan_Execution_Workflow.md` remains locally modified but untouched by this task — unrelated pre-existing in-flight work, same note as prior task reports.
