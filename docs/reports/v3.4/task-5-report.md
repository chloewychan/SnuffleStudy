# V3.4 Task 5 report: Remove the Task Vault breakdown-item feature

**Branch:** `v3.4` (already checked out per the calling instructions — confirmed with `git branch --show-current` → `v3.4`, and `git log --oneline -5`, which showed `0495a7b fix(v3.4-task3): finish and verify friend_requests test fixes, live DoD verification, report` on top). Did not create or switch branches, did not merge, did not push.

**Execution-order note honored.** Per the calling instructions, this task ran *before* Task 4 (dead-button removal), even though the plan's own "Build order" section lists them as parallelizable — Task 4's own Interfaces section explicitly says to sequence Task 5 first on `TaskVaultPage.tsx`/`StudyTab.tsx` so neither diff clobbers the other. `onClose`/the "Back" button in both files were deliberately left untouched (see "What's still open" below) for Task 4 to pick up next.

## Pre-flight verification against the live repo

Read the plan's Goal/Global Constraints and Task 5's full block (`docs/implementation_plans/V3.4_Implementation_Plan.md`, lines 1506–1643), plus `docs/scope_summaries/V3.4_Scope_Summary.md` Section 1 item 5 for the "why remove, not fix" rationale (a real behavioral inconsistency: natural session completion auto-completed a linked breakdown item, but manual/early `SESSION_END` deliberately did not — discovered during grounding, removed per a prior explicit decision rather than patched).

Read every file the plan said would be touched, in full, before editing: `domain/tasks/taskTypes.ts`, `domain/session/sessionTypes.ts`, `shared/messages.ts`, `background/messageRouter.ts`, `background/alarmHandlers.ts`, `infrastructure/storage/taskRepository.ts`, `app/routes/TaskVaultPage.tsx`, `sidepanel/components/StudyTab.tsx`, `sidepanel/components/SessionSetupForm.tsx`. All of the plan's claims held exactly against the live repo — `TaskBreakdownItem`/`Task.breakdown`/`taskBreakdownItemId`/`onStartSessionFromBreakdownItem`/`TASK_ADD_BREAKDOWN_ITEM`/`markBreakdownItemCompleted` all existed precisely as described, with no drift requiring adaptation.

## What I built

Exactly the Deliverables list, mechanically:

- **`domain/tasks/taskTypes.ts`** — `TaskBreakdownItem` interface and `Task.breakdown` field removed. `Task` is now `id`/`userId`/`title`/`createdAt`/`completedAt` (left `completedAt` untouched, per explicit out-of-scope note).
- **`infrastructure/storage/taskRepository.ts`** — `addBreakdownItem()` removed from `TaskRepository` and `IndexedDbTaskRepository`; no `DB_VERSION` bump (matches the plan — leftover on-disk `breakdown` arrays are simply never read/written again). Left `listAll()` in place even though its only caller (`markBreakdownItemCompleted`) is gone — the plan's Deliverables section only calls for `addBreakdownItem()`'s removal, not `listAll()`'s, so I didn't reach beyond stated scope.
- **`shared/messages.ts`** — `TASK_ADD_BREAKDOWN_ITEM` removed; `SESSION_CREATE`'s payload reverted to plain `CreateSessionInput`.
- **`background/messageRouter.ts`** — `TASK_ADD_BREAKDOWN_ITEM` case removed; `SESSION_CREATE` handler no longer merges `taskBreakdownItemId`; `TASK_CREATE`'s object literal drops `breakdown: []`.
- **`background/alarmHandlers.ts`** — `markBreakdownItemCompleted()` and its call site in the natural-completion branch removed entirely; nothing else in that branch changed (archival, `saveActiveSession`, `clearHardBlockRules`, `cancelFriendPollAlarm`, `recordFriendStatusEvent`, the completion notification are all byte-identical to before). Also dropped the now-unused `taskRepo`/`IndexedDbTaskRepository` import and instance (its only call site was the removed function).
- **`domain/session/sessionTypes.ts`** — `StudySession.taskBreakdownItemId` and its explanatory comment removed.
- **`app/routes/TaskVaultPage.tsx`** — breakdown-item list, "Add breakdown item" form, `breakdownDrafts` state, `handleAddBreakdownItem`, `handleToggleBreakdownItem`, "Start a session from this" button, and `onStartSessionFromBreakdownItem` all removed from both the component and `TaskVaultPageProps`. What remains: create a task, see a flat list, delete a task. `onClose`/the required `onClose: () => void` prop/the Back button are byte-identical to before (Task 4's job).
- **`sidepanel/components/StudyTab.tsx`** — `prefill` state, the `key={prefill?.taskBreakdownItemId ?? "default"}` remount trick, and `onStartSessionFromBreakdownItem` wiring all removed. `onClose={() => {}}` passed to `TaskVaultPage` is untouched (Task 4's job).
- **`sidepanel/components/SessionSetupForm.tsx`** — `initialGoal`/`taskBreakdownItemId` removed from props; `goal` reverted to plain `useState("")`; `SESSION_CREATE` payload literal drops `taskBreakdownItemId`. The Goal `<select>`, its `tasks`/`tasksProp` logic, and the "render the current goal as its own option" branch are untouched behaviorally — only updated the inline comment explaining that branch, since it previously cited the now-removed `initialGoal`/breakdown-item flow as its rationale (stale/misleading to leave as-is, but zero behavior change).
- **Tests** — every test file referencing the removed feature updated or trimmed: `taskRepository.test.ts` (dropped 3 `addBreakdownItem` tests + `breakdown: []` fixture noise), `messageRouter.test.ts` (dropped the `TASK_ADD_BREAKDOWN_ITEM` test and the whole `SESSION_END does NOT mark a linked task breakdown item complete` describe block; `TASK_CREATE`'s test now asserts the exact key set on the returned task instead of the removed field), `alarmHandlers.test.ts` (dropped the whole 3-test `handleAlarm marks a linked task breakdown item's completedAt` describe block + its now-unused `IndexedDbTaskRepository` import; the natural-completion behavior itself stays covered by the pre-existing `handleAlarm` describe block, unchanged), `sessionTypes.test.ts`/`sessionMachine.test.ts` (dropped the two `taskBreakdownItemId`-specific tests), `TaskVaultPage.test.tsx` (dropped 4 breakdown-specific tests, rewrote the rest to drop the now-removed `onStartSessionFromBreakdownItem` prop), `SessionSetupForm.test.tsx` (dropped the `initialGoal`/`taskBreakdownItemId` test and merged its one still-useful assertion — goal starts empty — into the top "creates and starts a session" test; stripped `breakdown: []` from fixtures), `StudyTab.test.tsx` (dropped the breakdown-prefill test), `SidePanelApp.test.tsx` (dropped the one breakdown-prefill integration test).

### Extra cleanup beyond the plan's enumerated file list

The DoD's grep bar (`grep -rn "breakdown\|Breakdown" snufflestudy/src/` must return **zero** matches, "deliberately broad") caught four more files with stray references not in the plan's Deliverables list, all fixed to satisfy the hard bar:
- **`background/friendSync.ts`** — a comment citing `alarmHandlers.ts's markBreakdownItemCompleted call` as a best-effort-pattern example; updated to cite a still-live example instead.
- **`background/messageRouter.ts`** — a stale comment in the `SESSION_END`/abandonment branch explaining that breakdown-item completion doesn't happen there; removed (the thing it was explaining no longer exists).
- **`options/pages/PrivacyPolicyPage.tsx`** — both the header audit comment and the user-facing "IndexedDB" bullet mentioned "tasks/breakdown items" / "task breakdowns"; updated to just "tasks," since that's now factually accurate.
- **`sidepanel/components/FriendGroupPanel.tsx`** — a genuinely unrelated use of the English word "breakdown" ("file-by-file breakdown" in a doc-pointer comment, nothing to do with this feature). Reworded to "per-file rundown" to satisfy the grep bar's explicit "zero matches, hard bar" wording rather than treat it as an exempt false positive.

Also reworded one test assertion in `messageRouter.test.ts` that would have failed its own DoD grep: an initial `expect(created.task).not.toHaveProperty("breakdown")` literally contains the string `"breakdown"`. Replaced with `expect(Object.keys(created.task).sort()).toEqual(["createdAt", "id", "title", "userId"])`, which verifies the same thing (no such field exists on the returned object) without the word appearing anywhere in the file.

## What I verified

**`grep -rn "breakdown\|Breakdown" snufflestudy/src/`** — zero matches, confirmed as the final step after all edits (including the four extra files above).

**`cd snufflestudy && npx vitest run`** — 84 test files, 878 tests, all passing.

**`cd snufflestudy && npm run compile`** — clean, zero errors. This is the primary verification for the DoD's "`TASK_CREATE` returns a `Task` with no `breakdown` field at all on the type" requirement — it's a type-level claim, confirmed by `Task` no longer having the field and every construction site compiling without it.

**Natural-completion path, verified via the test suite (not just by reading the code), per the DoD's explicit instruction:** ran `npx vitest run src/background/alarmHandlers.test.ts -t "auto-completes a FOCUSING session"` directly — 1 passed, 70 skipped. This is the pre-existing `handleAlarm` describe block's first test (creates a session, starts it, fires the session-timer alarm, asserts it lands in `COMPLETED` and stays the active session) — it now exercises the natural-completion branch with `markBreakdownItemCompleted`'s call site fully gone, and passes cleanly with no error and no reference to any removed field.

**`TASK_LIST` renders flat title/Delete rows only** — confirmed by reading the final `TaskVaultPage.tsx` JSX (no nested `<ul>`, no per-item form) and by `TaskVaultPage.test.tsx`'s surviving tests, which render real `TASK_LIST` responses and assert only a title span + Delete button per row.

No live-Supabase/schema verification was needed or performed — this task has no migration component, matching the plan's own framing ("pure client-side domain/storage/UI removal, no migration").

## Judgment calls

- **Left `taskRepository.ts`'s `listAll()` in place** even though it's now unused (its only caller was the removed `markBreakdownItemCompleted`). The plan's Deliverables section for this file only names `addBreakdownItem()` for removal; `listAll()` wasn't called out, so I treated removing it as out of this task's stated scope rather than an implied cleanup, mirroring the plan's own "leave `Task.completedAt` alone" precedent for not going beyond what's explicitly asked.
- **Fixed four files (`friendSync.ts`, `messageRouter.ts`'s abandonment comment, `PrivacyPolicyPage.tsx`, `FriendGroupPanel.tsx`) not in the plan's Deliverables list**, plus one test assertion's literal string, purely to satisfy the DoD's own explicit "deliberately broad... hard bar... zero matches" grep requirement. All were comment/copy-only changes with no behavior change; `FriendGroupPanel.tsx`'s fix in particular was a genuine false-positive (unrelated English usage of "breakdown"), but the DoD text left no discretion to exempt it.
- **Updated (rather than left stale) the `SessionSetupForm.tsx` comment explaining the Goal-select's "render current goal as its own option" branch**, since leaving it citing the just-removed `initialGoal` flow as its rationale would read as actively wrong to a future reader, even though the plan says this branch's logic itself is untouched. No behavior change — comment only.

## What's still open

**Deliberately left untouched, for Task 4 (running next, same-session, on top of this diff):** `TaskVaultPage.tsx`'s `onClose` prop (still required, not optional) and its "Back" button (`<button type="button" onClick={onClose}>Back</button>`, unconditional), and `StudyTab.tsx`'s `onClose={() => {}}` no-op passed to `TaskVaultPage`. These are Task 4's dead-button-removal scope exactly as the calling instructions specified — not a gap in this task, an intentional handoff boundary.

Nothing else outstanding within Task 5's own scope. Every Definition of Done item passed.
