# V4.2 Task 3 Report — Bunny tab

## What was built

Re-skinned `snufflestudy/src/sidepanel/components/BunnyTab.tsx` as `frontend-backup`'s
`AboutTheBun.tsx`/`InputBunnyName.tsx` design (found under
`frontend-backup/src/components/bunny/AboutTheBun.tsx` and
`frontend-backup/src/components/inputs/InputBunnyName.tsx` — not under `pages/tabs/`, which only
has the routing wrapper `BunnyPage.tsx` that composes `HeaderBar` + `NavigationBar` + `AboutTheBun`).
No new component files were created — per the plan's own File Structure section (only `BunnyTab.tsx`
is listed for this task) and matching Task 2's precedent (`HeaderBar.tsx`'s markup was inlined
directly into `Header.tsx`, not kept as a separate file), `AboutTheBun`'s and `InputBunnyName`'s
JSX were both inlined directly into `BunnyTab.tsx`.

Every hook, handler, and `sendMessage()` call is byte-identical to the pre-existing file — only the
JSX and its two CSS Module imports changed.

### `BunnyTab.tsx`
- JSX replaced with `AboutTheBun.tsx`'s markup (its own `<section>` root, `contentDisplay` flex row,
  `detailForm` column) minus any `HeaderBar`/`NavigationBar` (Decision 1 — `AboutTheBun.tsx` itself
  never imported them; only its parent `BunnyPage.tsx` did, which isn't the file being ported).
- Each `InputBunnyName` instance's `<h3>{bunnyName}</h3>` label became a real
  `<label htmlFor="bunny-name"|"human-name">` (carrying forward the pre-v4.2
  label/input association, per the Global Constraint that current accessibility attributes survive
  the re-skin even though `frontend-backup`'s own markup has none).
- Each instance's plain `<input placeholder="Textbox">` became a controlled input bound to
  `bunnyName`/`humanName` and the existing `onChange` handlers (unchanged logic, including the
  `setBunnyNameSaved(false)`/`setHumanNameSaved(false)` reset-on-edit behavior).
- Each instance's `ButtonBoolIcon` (a static, non-interactive checkmark `<img>` in
  `frontend-backup` — confirmed by reading `ButtonBoolIcon.tsx`: no `onClick` prop exists, and its
  `property1`/`property2` variant props have zero backing CSS anywhere, i.e. purely decorative
  Figma-export leftovers) is now wrapped in a real `<button>` calling
  `handleSaveBunnyName`/`handleSaveHumanName`, `disabled={saving... || !loaded}` exactly as before,
  with `aria-label` swapping between `"Save bunny name"`/`"Save human name"` (idle) and
  `"Saving…"` (in flight) — the same strings the old plain-text button used, so its accessible name
  states are unchanged even though the visible content is now an icon rather than text.
- `<img src="/Bunny@2x.png">` became `<img src={chrome.runtime.getURL("sidepanel/assets/Bunny@2x.png")}>`,
  per Task 1's asset convention (verified present at that exact output path after `npm run build`).
- The existing `loadError`/`bunnyNameSaveError`/`bunnyNameSaved`/`humanNameSaveError`/`humanNameSaved`
  `<p role="alert">`/`<p>Saved.</p>` messages are unchanged and kept next to their respective field.

### CSS
- Imports the two already-ported CSS Modules from Task 1 verbatim:
  `styles/frontend-backup/components/bunny/AboutTheBun.module.css` and
  `styles/frontend-backup/components/inputs/InputBunnyName.module.css`.
- One small addition to `InputBunnyName.module.css`: a `.saveButtonReset` class (border/background/
  padding/margin/font reset + `cursor: pointer`, plus a `:disabled` opacity dim), clearly commented
  as a v4.2 Task 3 addition — needed for the same reason Task 2 added `.buttonIconReset`/`.tabLink`:
  `global.css` has a bare `button { background: ...; border: ...; padding: ...; }` rule that would
  otherwise show through under the new design once `ButtonBoolIcon` is wrapped in a real `<button>`.

### Old CSS/classnames
- Confirmed via grep that `sp-bunny-tab`/`sp-bunny-tab__about` (the old classnames on this
  component's outer `<div>`/`<section>`) had **no dedicated CSS rules anywhere** in
  `styles/sidepanel.css` — they only ever existed as JSX hooks, styled entirely through the shared
  `.sp-card`/`.sp-tab-content`/`.sp-field` classes. Those shared classes are still used by other,
  not-yet-re-skinned tabs (`FriendsTab.tsx`, `StudyTab.tsx`, `SettingsTab.tsx`,
  `ActiveSessionView.tsx`, and `SessionSetupForm.tsx` for `.sp-field`) and were correctly left
  intact. `grep -rn "sp-bunny-tab" snufflestudy/src` → zero matches after this task's edit.

## Deviations from the plan's literal text (and why)
1. **Source files are `frontend-backup/src/components/bunny/AboutTheBun.tsx` and
   `frontend-backup/src/components/inputs/InputBunnyName.tsx`**, not under `pages/tabs/` as the
   task's own heading loosely implies — `pages/tabs/BunnyPage.tsx` is the routing wrapper (out of
   scope per Decision 1), and it simply imports `AboutTheBun` from `components/bunny/`. Verified by
   listing the actual `frontend-backup` tree before reading; no functional difference, just a path
   correction.
2. **`AboutTheBun`/`InputBunnyName` markup inlined into `BunnyTab.tsx` rather than ported as
   separate component files.** The plan's File Structure section lists only `BunnyTab.tsx` for this
   task (no new files), and Task 2 set the precedent of inlining a page-level component's markup
   directly into the existing shell file it replaces.
3. **Test file `BunnyTab.test.tsx` needed a scoping fix, not just copy/text updates.** The
   re-skinned Save buttons now carry `aria-label="Save bunny name"`/`"Save human name"` for
   accessible-name purposes. Testing Library's `getByLabelText` also matches elements labelled via
   a direct `aria-label`, so an unscoped `getByLabelText(/bunny name/i)` started resolving to *two*
   elements (the actual input, and the Save button) — a real ambiguity the new markup introduces,
   not a pre-existing flaw. Fixed by adding `{ selector: "input" }` to every `getByLabelText` call
   in the file (8 call sites), which keeps each query pointed at exactly the same text field it
   always resolved to. No assertion was weakened — every test still verifies the same behavior
   (field values, save-triggering, independent per-field saving/error state) it did before.

## What was verified, and how
- **`npm run compile` (`tsc --noEmit`), inside `snufflestudy/`** — clean.
- **`npm run build` (`wxt build`), inside `snufflestudy/`** — succeeds. Output listing confirms
  `sidepanel/assets/Bunny@2x.png` (186.05 kB) lands at the exact path
  `chrome.runtime.getURL("sidepanel/assets/Bunny@2x.png")` expects, alongside the already-present
  `button-check.svg` `ButtonBoolIcon` uses internally.
- **`npx vitest run src/sidepanel/components/BunnyTab.test.tsx`** — 9/9 pass (after the
  `getByLabelText` scoping fix described above; zero other test changes needed).
- **Full suite, `npx vitest run`** — 89 test files / 892 tests, all passing (identical totals to
  Task 1/2's baseline — confirms nothing elsewhere regressed).
- **Grep verification:**
  - `grep -rn "sp-bunny-tab" snufflestudy/src` → zero matches.
  - `grep -n 'src="/' snufflestudy/src/sidepanel/components/BunnyTab.tsx` → zero matches (no
    unconverted absolute asset paths left).
  - Confirmed `.sp-field`/`.sp-card`/`.sp-card__title`/`.sp-tab-content` remain defined in
    `styles/sidepanel.css` and are still referenced by other, not-yet-re-skinned components — correctly
    left alone, not this task's scope.
- **Manual trace (read-only, no browser in this environment) — cross-wiring check:** re-read the
  final JSX line by line. The bunny-name block's input, error message, saved message, and Save
  button reference only `bunnyName`/`setBunnyName`/`bunnyNameSaveError`/`bunnyNameSaved`/
  `savingBunnyName`/`handleSaveBunnyName`. The human-name block references only the human-name
  equivalents. No variable or handler is shared or swapped between the two blocks. This is also
  exercised directly by the passing "keeps the two Save buttons' loading/success state independent"
  test, which clicks bunny-save (hangs mid-flight), then clicks human-save (resolves immediately),
  and asserts the bunny button is still showing "Saving…" while the human button independently
  shows "Saved." — that test passed unmodified.

## Definition of Done — status
**Fully passed.**
- `npm run compile` and `npm run build` succeed.
- `npx vitest run` — `BunnyTab.test.tsx` passes (9/9), full suite green (892/892), no assertion
  weakened (only a necessary `getByLabelText` scoping fix, explained above).
- Grep confirms no leftover `sp-bunny-tab` classname anywhere in `snufflestudy/src`.
- Bunny-name and human-name save actions are confirmed independent, both by direct code trace and
  by the existing (still-passing) independence test.

No blockers encountered; no open items requiring the orchestrator's decision.

## Notes for later tasks
- `ButtonBoolIcon`'s `property1`/`property2` variant props (`"check"`/`"default"` etc.) have **no
  backing CSS anywhere** in `frontend-backup` — confirmed by grep (`ButtonTab.module.css` is the
  only file that keys off `data-property1`, and it targets a completely different component). Any
  later task that uses `ButtonBoolIcon` (Task 4's Task Vault "check" submit icon, Task 9's
  `FriendDetailsPopup` permission list per Decision 6) should not assume these props drive any
  visual state on their own — if a saving/checked/disabled visual distinction is needed, it has to
  come from a wrapping element's own class (as this task did with `.saveButtonReset:disabled`) or a
  new CSS rule added to `ButtonBoolIcon.module.css` itself.
- Confirmed (again, independently of Task 2's own note) that `global.css`'s bare `button {...}`
  chrome-reset need recurs anywhere a `frontend-backup` static `<img>`/`<div>` is promoted to a real
  `<button>`. This task added its own small, locally-scoped reset (`.saveButtonReset` in
  `InputBunnyName.module.css`) rather than reusing `HeaderBar.module.css`'s `.buttonIconReset`,
  since CSS Modules scope class names per-file and the two components aren't otherwise coupled.
- `getByLabelText` + `aria-label`-only buttons is a real collision risk worth flagging for any later
  task pattern-matching this one: if a promoted-to-button icon's accessible name shares a
  substring with a nearby field's label text, unscoped `getByLabelText(/.../)` queries in that
  component's existing tests may need the same `{ selector: "input" }` (or `"textarea"`/`"select"`)
  fix this task applied.
