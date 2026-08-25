# V3.4 Task 1 report: Shared backend auth helper

**Branch:** `v3.4` (already checked out per the calling instructions — did not create or switch branches). Confirmed with `git branch --show-current` (`v3.4`) and `git log --oneline` (top: `8066d55 docs: refine multi-step plan execution workflow` — no v3.4 commits yet, this is the first task on the branch).

## Pre-flight verification against the live repo

Read the plan's Goal/Architecture/Tech Stack/Global Constraints, all 8 Decisions, the Scope section, and Task 1's full block (`docs/implementation_plans/V3.4_Implementation_Plan.md`) before writing anything, plus `docs/scope_summaries/V3.4_Scope_Summary.md` Section 0 item 2 for prose context. Then checked every claim against the current repo rather than trusting the plan's prose:

- **`grep -rn "async function requireUserId" snufflestudy/src/infrastructure/backend/`** → 8 matches: `sessionEndRequestApi.ts`, `profileApi.ts`, `studyRoomApi.ts`, `friendGroupApi.ts`, `friendshipSettingsApi.ts`, `tempPasscodeApi.ts`, `unlockRequestApi.ts`, `producerTagApi.ts`.
- **`grep -rn "async function checkAuth" snufflestudy/src/infrastructure/backend/`** → 8 matches: `digestApi.ts`, `nudgeApi.ts`, `unlockRequestApi.ts`, `coachingApi.ts`, `sessionEndRequestApi.ts`, `sessionStatusSyncApi.ts`, `producerTagApi.ts`, `tempPasscodeApi.ts`.
- Union of both sets = exactly the 12 files the plan names, no more, no less. 4 files (`sessionEndRequestApi.ts`, `tempPasscodeApi.ts`, `unlockRequestApi.ts`, `producerTagApi.ts`) have both; the rest have exactly one.
- Read every occurrence's surrounding context in all 12 files (not just a diff/text match) — every `requireUserId()` body and every `checkAuth()` body is byte-identical to the plan's verbatim block, including the `.getUser()`/`.getSession()` split described in the Interfaces section.
- Confirmed `authHelpers.ts` did not already exist (`ls` → "No such file or directory").
- Confirmed `messageRouter.ts`'s own `currentUserId()` (line 46) is a distinct, non-throwing, `string | null`-returning helper with its own body, per the plan's explicit carve-out — left untouched.
- Checked all 14 `infrastructure/backend/*.test.ts` files for any mock of `requireUserId`/`checkAuth` by name (`grep vi.mock` for auth-related mocks) — found none; every test mocks `supabase.auth.*` directly, so no test import paths needed updating.

### Discrepancy found: plan's "10 files" arithmetic doesn't reconcile to the file list it itself gives

The plan's Deliverables section says "10 existing files edited... (the count above minus the 3 files Task 3 deletes wholesale)". Working from the same 12-file list the plan's own Interfaces section enumerates, and excluding both (a) `friendGroupApi.ts` — explicitly deferred to Task 2's rename/rewrite, not edited here — and (b) the 3 files Task 3 deletes outright (`tempPasscodeApi.ts`, `unlockRequestApi.ts`, `sessionEndRequestApi.ts`), the correct count is **12 − 1 − 4 = 8**, not 10. (The calling instructions' own restatement of this reasoning arrives at the same "10" figure, inheriting the same arithmetic slip.) The *file list itself* is unambiguous — the plan names all 12 files individually and is explicit that `friendGroupApi.ts` moves to Task 2 and the 3 request-table files die in Task 3 — so I edited exactly the 8 files that logically remain: `friendshipSettingsApi.ts`, `producerTagApi.ts`, `studyRoomApi.ts`, `profileApi.ts`, `sessionStatusSyncApi.ts`, `nudgeApi.ts`, `digestApi.ts`, `coachingApi.ts`. I did not touch `friendGroupApi.ts`, `tempPasscodeApi.ts`, `unlockRequestApi.ts`, or `sessionEndRequestApi.ts`, per the plan's own stated rationale (verified still holds — Tasks 2/3 have not landed on this branch).

## What I built

- **`snufflestudy/src/infrastructure/backend/authHelpers.ts`** (new): exports `requireUserId()` and `checkAuth()` verbatim from the plan's Interfaces block, importing `supabase` from `./supabaseClient`.
- **8 files edited** to import from `authHelpers.ts` instead of defining a local copy, importing only the shape(s) each file actually uses:
  - `requireUserId` only: `friendshipSettingsApi.ts`, `studyRoomApi.ts`, `profileApi.ts`
  - `checkAuth` only: `sessionStatusSyncApi.ts`, `nudgeApi.ts`, `digestApi.ts`, `coachingApi.ts`
  - both: `producerTagApi.ts`
  Each file's local function body (and its explanatory "mirrors X's helper" comment, since that rationale is now centralized in `authHelpers.ts`) was deleted; the `import { supabase } from "./supabaseClient"` line was preserved in every file since all 8 still call `supabase.*` for other purposes (verified — none became an unused import).
  - **One exception to "delete the comment too"**: `sessionStatusSyncApi.ts` has a local `currentUserId()` that wraps `checkAuth()` and has exactly one call site (this file's own `recordStatusEvent`/`fetchNewEventsForFriends`). Its comment block (why `getSession()` over `getUser()`, the hot-path rationale) still documents *this file's* design choice, not just the removed function, so I kept the comment and replaced only the function body with a one-line pointer to `authHelpers.ts`.
- No behavior change anywhere — pure extraction, same as the plan specifies. Did not touch `messageRouter.ts`'s `currentUserId()`.

## What I verified

- **`grep -rn "async function requireUserId" snufflestudy/src/infrastructure/backend/`**: exactly 5 matches remain — `authHelpers.ts` (the real one) plus the 4 deferred files (`sessionEndRequestApi.ts`, `tempPasscodeApi.ts`, `unlockRequestApi.ts`, `friendGroupApi.ts`), each expected and untouched per the deferral above.
- **`grep -rn "async function checkAuth" snufflestudy/src/infrastructure/backend/`**: exactly 4 matches remain — `authHelpers.ts` plus 3 deferred files (`tempPasscodeApi.ts`, `sessionEndRequestApi.ts`, `unlockRequestApi.ts`).
  (Both results correctly show "exactly one match inside `authHelpers.ts`" among the *edited* set — the DoD's literal "exactly one match, period" only holds once Task 2/3 delete/rewrite the 4 deferred files, which is expected and out of this task's scope.)
- **`npm run compile` (`tsc --noEmit`)**: clean, zero errors, both before and after the edits.
- **`npx vitest run`**: baseline (before any edit) was 91 test files / 1011 tests, all passing. After all edits: still **91 test files / 1011 tests, all passing** — identical counts, no test needed a mock-path update (confirmed no test mocked `requireUserId`/`checkAuth` directly).
- **`git status --short`**: exactly 8 modified files + 1 new file (`authHelpers.ts`), matching the intended scope precisely — nothing outside this task touched.
- Manually confirmed `supabase` remains a used import in every edited file (`grep -n "supabase"` per file) so no edit introduced an unused-import warning.

## What's still open

- Nothing outstanding within Task 1's own scope. `friendGroupApi.ts`/`tempPasscodeApi.ts`/`unlockRequestApi.ts`/`sessionEndRequestApi.ts` still carry their own local `requireUserId()`/`checkAuth()` copies by design — Task 2 renames+rewrites `friendGroupApi.ts` (picking up `authHelpers.ts` from the start per its own Interfaces spec) and Task 3 deletes the other 3 outright, so neither needs (or should get) a transitional edit here.
- Flagged above: the plan's Deliverables text says "10 existing files edited" where the file list it itself provides works out to 8. Worth a one-line correction in the plan doc if it's revisited, but does not change what should be built — the explicit file-by-file reasoning is unambiguous and is what I followed.
