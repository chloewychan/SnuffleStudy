# V4.1 Task 5 — Bunny tab — Report

## Scope

Only `snufflestudy/src/sidepanel/components/BunnyTab.tsx` and its test file
`snufflestudy/src/sidepanel/components/BunnyTab.test.tsx` were touched, per the task's
instructions. No other files were modified.

## Verification of the plan's claims against the current repo

Before editing, read the current `BunnyTab.tsx` in full and confirmed:

- `showBunny` state existed exactly as described (`useState(true)`), rendered as a
  `<label className="sp-field sp-field--toggle" htmlFor="show-bunny">` wrapping an
  `sp-toggle` checkbox structure.
- The status section existed exactly as described: a `STUB_METERS` constant array
  (Happiness/Productivity/Friendliness) rendered via `.map()` inside
  `<section className="sp-card sp-bunny-tab__status">`.
- There was a single `handleSave`/`saving`/`saveError`/`saved` trio wired to one
  `<button onClick={handleSave}>Save</button>`, calling `PROFILE_SAVE_MINE` with
  `{ humanName, bunnyName }`.

All three claims in the plan matched the actual file exactly — nothing was stale.
`grep` confirmed `showBunny`, `STUB_METERS`, and `sp-bunny-tab__status` were not referenced
anywhere else in the codebase, so removing them from this file alone is complete (the
`sp-meter*`/`sp-toggle*` CSS in `src/styles/sidepanel.css` becomes unused dead code, but per
the task's constraint I did not touch files outside `BunnyTab.tsx`/its test — CSS cleanup is
left as-is, matching the plan's general policy of deferring dead-code removal).

## What was built

In `BunnyTab.tsx`:

- Removed `showBunny` state and the entire `<label ... htmlFor="show-bunny">` toggle block.
- Removed `STUB_METERS` and the entire `<section className="sp-card sp-bunny-tab__status">`
  block (Happiness/Productivity/Friendliness meters).
- Replaced the single `handleSave`/`saving`/`saveError`/`saved` trio with two fully independent
  trios: `savingBunnyName`/`bunnyNameSaveError`/`bunnyNameSaved` and
  `savingHumanName`/`humanNameSaveError`/`humanNameSaved`, each driving its own button
  ("Save bunny name" / "Save human name"). Both `handleSaveBunnyName()` and
  `handleSaveHumanName()` call `PROFILE_SAVE_MINE` with the same `{ humanName, bunnyName }`
  payload (message contract unchanged — both fields always sent together), but each function
  only touches its own state trio, so one button's "Saving…"/"Saved." never affects the other.
- Each name `<input>`'s `onChange` now only clears its own field's `*Saved` flag (bunny input
  clears `bunnyNameSaved`, human input clears `humanNameSaved`) rather than a single shared
  `saved` flag — a small necessary consequence of splitting the state that keeps each button's
  success indicator tied to its own field being edited again.
- Both buttons are disabled while their own save is in flight or before the initial
  `PROFILE_GET_MINE` load resolves (`disabled={savingBunnyName || !loaded}` /
  `disabled={savingHumanName || !loaded}`), matching the original single button's `!loaded`
  guard.

In `BunnyTab.test.tsx`:

- Removed the "toggles Show Bunny" and "renders the three status meters" tests, replaced with
  one test asserting the toggle checkbox and the three meter labels are all absent.
- Renamed/duplicated the old single "Save" tests into "Save bunny name" and "Save human name"
  variants (button-name lookups updated, e.g. `getByRole("button", { name: "Save bunny name" })`).
- Added an explicit independence test: it starts a bunny-name save that hangs on an unresolved
  promise, confirms the bunny button reads "Saving…" while the human button still reads its idle
  label, then clicks "Save human name" (using a separate immediately-resolving mock response) and
  confirms it shows "Saved." while the bunny button is still "Saving…", then resolves the bunny
  save and confirms both show "Saved." independently.
- All other pre-existing tests (stub defaults, typing, loading a saved profile, error handling)
  were kept, only renamed to the new button label where relevant.

## Verification performed

- `cd snufflestudy && npm run compile` (`tsc --noEmit`) — clean, no errors.
- `npx vitest run src/sidepanel/components/BunnyTab.test.tsx` — 9/9 tests pass.
- `npm run test` (full suite) — 896/899 tests pass across 84 files. The 3 failures are all in
  `src/sidepanel/components/Header.test.tsx` (`useRefreshAll must be used within a
  RefreshRegistryProvider`), caused by **uncommitted, in-progress work from a different task**
  (Task 2 — the refresh registry: `sidepanel/refresh/RefreshRegistryContext.tsx` is untracked
  and `Header.tsx` has uncommitted changes wiring in `useRefreshAll()`, both present in the
  working tree from a concurrent task, not from this task). Confirmed via `git status`/`git diff
  --stat` that `Header.tsx`/`Header.test.tsx` were not touched by this task's changes, and that
  the failure is unrelated to `BunnyTab.tsx`. Left as-is — out of scope for Task 5 to fix another
  task's in-flight files.

## Judgment calls / deviations

- None from the plan's Deliverables — implemented exactly as specified. The only implementer
  decision was how `onChange` should interact with the now-split `*Saved` flags (each field only
  clears its own save-success indicator on edit), which is the natural consequence of "each
  button owns its own state" and wasn't otherwise specified.

## Open items

- None for Task 5 itself. The pre-existing `Header.test.tsx` failures noted above belong to
  Task 2's in-progress work elsewhere in the same working tree and are not part of this task's
  scope.
