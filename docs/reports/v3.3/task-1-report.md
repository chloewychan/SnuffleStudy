# V3.3 Task 1 report: Move Temp Passcode + Unlock Request panels into the Friends tab

**Branch:** `v3.3` (already checked out, per the calling instructions — did not create or switch branches). Confirmed with `git branch --show-current` (`v3.3`) and `git log --oneline` (top: `e4ed8e7 docs(v3.3): scope summary, feature feedback, and implementation plan`) before starting.

## Pre-flight verification against the live repo

Read `SettingsTab.tsx` and `FriendsTab.tsx` directly rather than trusting the plan's prose, per the task instructions:

- **`SettingsTab.tsx`** (before this change): rendered exactly `<TempPasscodePanel onClose={() => {}} />` and `<UnlockRequestPanel session={null} onClose={() => {}} />`, each inside its own `<section className="sp-card">`, inside a `<div className="sp-tab-content sp-settings-tab">` — matches the plan's Task 1 prose verbatim.
- **`FriendsTab.tsx`** (before this change): rendered `<StudyRoomPanel onClose={() => {}} />` then `<FriendGroupPanel onClose={() => {}} />`, same `sp-card`/`sp-tab-content sp-friends-tab` structure — matches the plan's "below its existing `<StudyRoomPanel>`/`<FriendGroupPanel>`" claim exactly.
- Confirmed `TempPasscodePanel.tsx`'s and `UnlockRequestPanel.tsx`'s prop signatures (`{ onClose: () => void }` and `{ session: StudySession | null; onClose: () => void }` respectively) and their real `<h2>` headings (`Temporary passcode requests`, `Unlock requests`) directly from source before writing test assertions against them.

No stale claims found in Task 1's own block — the plan's description of both files' current contents matched the repo exactly, so no deviation from the plan's approach was needed here (unlike v3.3's own comment-block precedent elsewhere in this codebase for composed panels, where design-order verification overrode the brief's prose — not applicable to this task, which specifies the order directly and correctly).

## What I built

- **`FriendsTab.tsx`:** added imports for `TempPasscodePanel` and `UnlockRequestPanel`, and appended two more `<section className="sp-card">` blocks after the existing `StudyRoomPanel`/`FriendGroupPanel` sections — `<TempPasscodePanel onClose={() => {}} />` then `<UnlockRequestPanel session={null} onClose={() => {}} />`, in that order, per the plan's Deliverables. Added a short header comment explaining the move and why `session={null}` is correct here (no notion of an active session in this tab, so only `UnlockRequestPanel`'s "Requests from friends" approver section renders).
- **`SettingsTab.tsx`:** removed both panel imports and JSX; now exports exactly `<div className="sp-tab-content sp-settings-tab" />` as specified, with a comment noting Task 7 is what fills it back in.
- **`FriendsTab.test.tsx`:** updated the existing structural test to expect 4 top-level `<section>`s (was 2), added heading assertions for `TempPasscodePanel`/`UnlockRequestPanel`, kept the `session={null}` regression check (`"Request an unlock"` absent, `"Requests from friends"` present) that previously lived in `SettingsTab.test.tsx`, and extended both the on-mount-fetch assertions and the fetch-failure test to cover all four composed panels.
- **`SettingsTab.test.tsx`:** replaced entirely — the old test asserted on the two panels that no longer live here; the new test asserts the tab renders exactly one empty `.sp-tab-content.sp-settings-tab` element and nothing else.

## Deviation from the calling instructions: a third test file needed updating

The calling instructions named `FriendsTab.test.tsx`/`SettingsTab.test.tsx` as the tests to update. Running the full suite (`npx vitest run`) after the above changes surfaced one more failure outside those two files: **`snufflestudy/src/sidepanel/SidePanelApp.test.tsx`**, in `"routes each of the four tabs to its own distinct content"`. That test used `TempPasscodePanel`'s `<h2>Temporary passcode requests</h2>` heading as the Settings tab's distinguishing content — now that heading also renders inside the Friends tab, the test's own "every other tab's heading must be absent" assertion correctly caught that the two tabs were no longer mutually exclusive on that heading.

This is a direct, mechanical consequence of Task 1's move, not scope creep: leaving it broken would mean `npm run test` doesn't pass, which is both this task's own Definition of Done ("both pass" — read in context of "the suite must be green") and the explicit instruction to run `npm run test` and treat the result as gating. I updated it minimally:
- Dropped the `Settings` entry from the 4-heading table (Settings has no heading right now — `SettingsTab.tsx` is deliberately empty until Task 7).
- Added an explicit assertion that clicking each of Bunny/Study/Friends does *not* mount `.sp-settings-tab`, and a separate block confirming the Settings tab mounts its empty placeholder with none of the other three tabs' headings present.
- Left the file's two other TempPasscodePanel/UnlockRequestPanel tests (lines ~120–213) untouched — those exercise a completely different code path in `SidePanelApp.tsx` (the `showUnlockPanel`/`showTempPasscodePanel` branches triggered from `ActiveSessionView`'s own buttons during an active session, which replace the *active session view*, not the tab shell) and were unaffected by this move.

I did not touch anything else outside Task 1's three files' immediate blast radius (`FriendsTab.tsx`, `SettingsTab.tsx`, their two test files, and this one incidental test-suite casualty).

## What I verified

- `npx vitest run src/sidepanel/components/FriendsTab.test.tsx src/sidepanel/components/SettingsTab.test.tsx` → 2 files, 3 tests, all passed.
- `npx vitest run` (full suite, from `snufflestudy/`) → **86 files, 838 tests, all passed** (was 86 files/838 tests before my `SidePanelApp.test.tsx` fix too — I updated an existing test's assertions rather than adding new test cases, so the count didn't change; verified this by re-running after each edit rather than just before/after totals).
- `npm run compile` (`tsc --noEmit`, from `snufflestudy/`) → clean, no type errors.
- Manually re-read the final `FriendsTab.tsx` and `SettingsTab.tsx` end to end to confirm: Friends tab shows, top to bottom, Study Rooms → Friend activity → Temporary passcode requests → Unlock requests (matches the Definition of Done's stated order exactly); Settings tab renders only the empty placeholder div.
- `git diff --stat` confirms the only files touched are `FriendsTab.tsx`, `SettingsTab.tsx`, their two test files, and `SidePanelApp.test.tsx` (the incidental fix above) — no files belonging to other numbered tasks in the plan were modified. `docs/Multi_Step_Plan_Execution_Workflow.md` shows as locally modified but is unrelated pre-existing in-flight work (per the plan's own "Repository state, checked directly" section) — left untouched and not included in this task's commit.

## What's still open

Nothing within Task 1's own scope. The Settings tab is intentionally empty — Task 7 is what makes it non-empty, exactly as the plan states. No other task's files were touched.
