# V3.3 Task 11 report: Message field on temp-passcode requests

**Branch:** `v3.3` (already checked out, per the calling instructions — did not create or switch branches). Confirmed with `git branch --show-current` (`v3.3`) and `git log --oneline` (top: `9934d63 feat(v3.3-task10): temp-passcode redesign — approve then auto-claim, no code`) before starting. Tasks 1/2/3/5/6/7/8/9/10 already landed (`c472385`, `e94eab7`, `0ac177e`, `bb20fd3`, `c6cd092`, `bef185e`, `ecbcbb1`, `8937fc9`, `9934d63`).

## Pre-flight verification against the live repo

Read Task 11's full block, Decision 2 (why Task 10 had to land first — same table, sequenced migration, to avoid one migration both adding and dropping columns), and Task 10's block for context, before writing anything. Then checked the CURRENT (post-Task-10) shape of every file Task 11 touches, rather than assuming the pre-Task-10 shape the calling instructions warned about:

- **`supabase/migrations/`**: confirmed `20260815000036_v3.3_temp_passcode_no_code.sql` exists and its `alter table temp_passcode_requests drop column code_hash, drop column code_salt, drop column failed_attempts, drop column locked_until` actually ran — next sequential migration number is `20260815000037`.
- **Live DB** (`snufflestudy/.env`, direct `pg` query against `information_schema.columns`): confirmed the live `temp_passcode_requests` table currently has exactly `delivered_via, expires_at, friend_user_id, hostname, id, requested_at, requester_user_id, resolved_at, session_id, status` — no code columns, no `message` yet. Matches the migration file exactly; Task 10 is genuinely applied live, not just committed.
- **`tempPasscodeApi.ts`**: confirmed `TEMP_PASSCODE_COLUMNS` was already narrowed to the ten post-Task-10 columns, `toTempPasscodeRequest`/the row interface had no code fields, and `createRequest(sessionId, hostname, friendUserId)` took exactly three params.
- **`domain/accountability/tempPasscodeRequest.ts`**: confirmed `TempPasscodeRequest` had no code fields.
- **`TempPasscodePanel.tsx`**: confirmed the exact current requester/hostname line (`{displayName(r.requesterUserId)} wants a temporary passcode for {r.hostname}`, using Task 8's `useDisplayNames`, not a raw id) to insert the message display next to, rather than reintroducing a raw-id reference.
- **`LockedPage.tsx`**: confirmed the current friend-picker section (`selectedFriendId`/`effectiveFriendId`, Task 8's `displayName`) and `handleRequestTempPasscode`'s current three-field payload, to know exactly where the new input and payload field belong.

No corrections were needed to the plan's Task 11 prose — Task 10's landed shape matched what the plan assumed.

## What I built

- **Migration `supabase/migrations/20260815000037_v3.3_temp_passcode_message.sql`**: `alter table temp_passcode_requests add column message text` (nullable, no `CHECK` — length limits belong on the client input, per the plan's own Deliverables line), **plus** `grant select (message) on temp_passcode_requests to authenticated`. That grant statement is not in the plan's literal one-line SQL — see "A real gap found" below.
- **`tempPasscodeApi.ts`**: `TEMP_PASSCODE_COLUMNS` gains `message`; the row interface and `toTempPasscodeRequest` map it through as `string | null`; `createRequest(sessionId, hostname, friendUserId, message?)` gains an optional fourth param, spread into the insert body only when truthy (`...(message ? { message } : {})`) so a message-less call's insert body — and the existing "inserts a pending row" unit test's exact-body assertion — stays byte-for-byte unchanged.
- **`domain/accountability/tempPasscodeRequest.ts`**: `TempPasscodeRequest` gains `message: string | null`.
- **`shared/messages.ts`**: `TEMP_PASSCODE_CREATE`'s payload gains `message?: string`.
- **`messageRouter.ts`**: `TEMP_PASSCODE_CREATE`'s case forwards `message.payload.message` through to `createRequest` as the fourth argument.
- **`LockedPage.tsx`**: a new `requestMessage` state and a text `<input>` ("Why do you need this? (optional)") rendered right after the friend picker / "No friends available" block, before the "Request a temporary passcode" button. On submit, the value is trimmed and included in the `TEMP_PASSCODE_CREATE` payload only when non-empty (an all-whitespace or untouched input never sends a stray `message: ""` — `createRequest` treats any truthy `message` as "the requester provided one").
- **`TempPasscodePanel.tsx`**: `r.message`, when present, renders as a quoted `<p className="temp-passcode-panel__message">` line directly under the existing requester/hostname `<span>`, inside the same `<li>`. Nothing renders when `r.message` is falsy (empty string or `null`) — no placeholder text.

**Judgment call — `maxLength={280}`:** not specified by the plan (which explicitly leaves any length limit to the UI, not a DB `CHECK`). Picked 280 as long enough for a real sentence or two of context ("why do you need this"), short enough to stay a short aside rather than invite an essay in a passcode-request flow.

**Judgment call — empty/whitespace messages are treated as "no message" on both ends.** `LockedPage.tsx` trims and omits the payload key entirely when blank; `createRequest` only inserts `message` when the value is truthy (so an explicit empty string sent by some other future caller would also be treated as absent). This keeps the "renders exactly as it does today, no empty placeholder text" half of the DoD true regardless of which layer a blank value originates from.

## A real gap found, not in the plan's prose but in its literal SQL

The plan's given migration is a bare `alter table temp_passcode_requests add column message text;`. Checking the live DB's actual column-level grants (not just the migration files) surfaced that `20260815000016_v2_temp_passcode_hard_mode.sql` had *revoked* table-level `SELECT` from `authenticated` entirely and replaced it with a **column-level** `SELECT` grant naming an explicit list of columns. A table-level grant (this table's `INSERT`/`DELETE`, still table-level since `20260815000003`) automatically extends to a newly added column, but a column-level grant does not — a new column added by a bare `ADD COLUMN` comes out with `INSERT`/`REFERENCES` (inherited from the table-level grants) but **no `SELECT`** for `authenticated`, since it was never named in that explicit list.

Confirmed this live, not just by reading the grant SQL: applied the bare `add column` first, then ran a real authenticated-user insert-and-select against `TEMP_PASSCODE_COLUMNS` (which now includes `message`) — it failed with `permission denied for table temp_passcode_requests`, a genuine Postgres GRANT-layer denial (distinct from an RLS "row violates policy" error). Fixed by adding `grant select (message) on temp_passcode_requests to authenticated;` to the migration, applied the missing grant statement directly to the live DB (the file's `add column` half had already run and was recorded in `_migrations`, so re-running the whole file would have failed on "column already exists" — the grant was applied as a standalone statement, matching the corrected file's end state), then reran the same live insert-and-select check, which passed. The migration file in the repo now contains both statements together, so a fresh `apply-migrations.mjs` run against a clean DB gets the correct end state in one shot.

## What I verified

- **`npm run test`** (from `snufflestudy/`): **88 files, 902 tests, all passed.** Added/updated: `tempPasscodeApi.test.ts` (new `message`-in-insert-body test, `sampleRow`/result assertions gain `message: null`, the pinned `TEMP_PASSCODE_COLUMNS` string updated), `TempPasscodePanel.test.tsx` (new "shows the requester's message when present" / "renders no message placeholder when the request has none" tests, `pendingForMe` fixture gains `message: null`), `LockedPage.test.tsx` (new "includes a trimmed message..." / "omits the message key entirely when blank" tests), `messageRouterTempPasscode.test.ts` (new "forwards an optional message" test, `sampleRequest` fixture gains `message: null`), `alarmHandlers.test.ts` (`sampleTempPasscodeRequest`'s base object gains `message: null` — a type-only fix, no behavioral test change).
- **`npm run compile`** (`tsc --noEmit`): clean.
- **`node scripts/apply-migrations.mjs`** (live dev DB, via `snufflestudy/.env`): `20260815000037` applied cleanly (after the grant fix above).
- **Direct `pg` query** against `information_schema.columns`: confirmed `message` exists on the live `temp_passcode_requests` table, type `text`, `is_nullable = YES`.
- **A separate ad-hoc, not-committed script** (`verify-task11-message.mjs`, written directly for this task's own live sign-off, run from `snufflestudy/scripts/` so its `dotenv`/`@supabase/supabase-js` imports resolved, then deleted — matching the convention `docs/reports/v3.3/task-10-report.md` documents for its own ad-hoc `verify-task10-live.mjs`) proved the DoD's functional claim directly, as a real signed-in user (RLS-bound, not the service-role client) doing the exact insert/select shape `createRequest`/`TEMP_PASSCODE_COLUMNS` use:
  1. An insert with `message: "Need to check the syllabus"` round-trips through the exact `TEMP_PASSCODE_COLUMNS` select — **pass**.
  2. A fresh, separate re-read of that same row (not just the insert's own returned data) still carries the message — **pass**.
  3. A message-less insert (`createRequest`'s default path) still succeeds, with `message: null` — **pass**.
  4. Cleanup: the two inserted rows, the two ephemeral test accounts, and the shared group/membership rows used to satisfy the INSERT policy's shared-group-floor check were all deleted via the service-role client, then re-queried to confirm zero leftovers — **pass**.
  All 5 checks passed; deleted immediately after the run (`rm snufflestudy/scripts/verify-task11-message.mjs`), not part of the commit.

This task's DoD is functional, not a new access-control boundary — no negative case was required, matching the calling instructions; the live check above focused on proving the round-trip actually works for a real `authenticated`-role user, which is exactly what surfaced the grant gap above (a pure schema/RLS-inspection pass would have missed it, since RLS itself was never the problem).

## What's still open

Nothing deferred within this task's own scope. As with prior tasks, the two changed Edge Functions this task does *not* touch (`approve-temp-passcode`, `send-temp-passcode-request`) remain untouched by Task 11 — the plan's Deliverables list doesn't ask for `message` to appear in either function's email body or response, and neither was changed. `verify-temp-passcode.mjs` (the permanent, committed live-verification script) was also left unchanged — Task 11's DoD, unlike Task 10's, doesn't call for updating it, and its own `NARROW_COLUMNS` constant not including `message` doesn't break anything it currently checks.

## Files changed

- `supabase/migrations/20260815000037_v3.3_temp_passcode_message.sql` (new)
- `snufflestudy/src/infrastructure/backend/tempPasscodeApi.ts` / `.test.ts`
- `snufflestudy/src/domain/accountability/tempPasscodeRequest.ts`
- `snufflestudy/src/shared/messages.ts`
- `snufflestudy/src/background/messageRouter.ts`, `messageRouterTempPasscode.test.ts`
- `snufflestudy/src/app/routes/LockedPage.tsx` / `.test.tsx`
- `snufflestudy/src/sidepanel/components/TempPasscodePanel.tsx` / `.test.tsx`
- `snufflestudy/src/background/alarmHandlers.test.ts` (fixture-only, no behavioral change)

`docs/Multi_Step_Plan_Execution_Workflow.md` remains locally modified but untouched by this task — unrelated pre-existing in-flight work, same note as prior task reports.
