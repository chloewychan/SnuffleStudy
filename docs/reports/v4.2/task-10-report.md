# V4.2 Task 10 Report — Nudge Vault box

## What was built

Re-skinned `snufflestudy/src/sidepanel/components/NudgeVaultBox.tsx` as `frontend-backup`'s
`NudgeVaultPanel.tsx` design (found at
`frontend-backup/src/components/friends/NudgeVaultPanel.tsx` — under `components/friends/`, not
`pages/tabs/`; the CSS module Task 1 already ported lives at
`snufflestudy/src/sidepanel/styles/frontend-backup/components/friends/NudgeVaultPanel.module.css`,
verified directly rather than assumed). Every hook, handler, and `sendMessage()` call in
`NudgeVaultBox.tsx` is byte-identical to the pre-existing code — only the JSX `return (...)` block
and its per-row sub-component's JSX changed. `ProducerTagRecorder.tsx` (the shared
record→preview→send widget this box wraps) was also re-skinned per the task's own instruction — its
state machine (`recording`/`preview`/`recordError`/the countdown timer/`handleStart`/
`finishRecording`/`handleDiscard`) is untouched; only its `return (...)` block changed.

### `NudgeVaultBox.tsx`
- Outer root: `<section className={styles.nudgeVaultPanel}>` (design's own root is a `<main>`;
  normalized to `<section>` to match every other top-level box's landmark choice in this codebase —
  `FriendsBox.tsx`, `StudyRoomsBox.tsx`, etc. all use `<section>`, not `<main>`, since only one
  `<main>` should exist per page).
- **Audio nudges section**: "Audio Nudges (10s max)" heading + `<ProducerTagRecorder onSend={...}
  sending={savingAudio} sendLabel="Save to vault" />` in place of the design's static "Record New
  Audio Nudge" `ButtonLarge` placeholder — the actual multi-state recorder widget renders there
  instead (see below). Below it, the existing loading/empty/error paragraphs are unchanged, and the
  list (`<ul className={styles.exampleListItems}>`) renders one `VaultAudioTagRow` `<li>` per tag,
  preserving `<ul>/<li>` list semantics (Global Constraint — `frontend-backup`'s own markup here is
  bare `<div>`s) grafted with the design's own classes, matching the "keep list semantics, graft the
  new design's classes on" precedent from Tasks 4/7/8/9.
- **`VaultAudioTagRow`**: unchanged `playbackUrl`/`loading`/`error` state and `handlePlay` logic.
  JSX: bullet-dot decorative icon (a genuinely decorative list marker in this design, unlike
  `FriendPanel.tsx`'s bullet-dot, which Task 9 turned into a real checkbox — confirmed by reading
  the design source: nothing elsewhere in `NudgeVaultPanel.tsx` treats this icon as selectable), the
  clip-length label, then either the lazily-downloaded `<audio controls autoPlay>` or an `IconButton`
  ("Play"/"Loading…", `icon-play-pause.svg`) — the design's own markup literally calls the
  `IconButton` component here (confirmed by reading the source), so the shared primitive was used
  directly rather than a raw `<img>`. A second `IconButton` ("Delete"/"Deleting…", `icon-trash.svg`)
  binds to the existing `onDelete`/`deleting` props.
- **Written nudges section**: "Written Nudges" heading + the textbox row + list, same structural
  shape as the audio section. The textbox row is a `<div className={styles.newNudgeEditor}>` (NOT a
  `<form>` — see Deviation 1 below) containing a `TextInput` (bound to `newText`/`onChange`,
  `ariaLabel="New nudge"` since the design has no visible label text for this field — same "carry
  forward the pre-existing accessible name via `ariaLabel`" pattern Task 9 established) and a real
  `<button type="button" onClick={handleAddText}>` wrapping a plain `<img src=".../button-check.svg">`
  (the design's own markup here is a bare `<img>`, **not** the `ButtonBoolIcon` component — confirmed
  by reading the source; this matches `FriendsBox.tsx`'s identical "Add Friend" check-icon treatment
  from Task 9, which used the same raw-button-wraps-raw-img pattern for the same reason). Disabled
  per the existing `savingText || !newText.trim()` check; `aria-label` swaps `"Add"`/`"Adding…"`
  (same convention as Task 3's Save-bunny-name button).
- Each written-nudge `<li>`: bullet-dot decorative icon, the nudge body text, then an `IconButton`
  for **Edit** (present, `icon-edit.svg`, label `"Edit"`, **no `onClick` prop passed at all** — see
  "Open item" below) and an `IconButton` for **Delete** (`icon-trash.svg`, "Delete"/"Deleting…")
  bound to the existing `handleDeleteText`/`deletingTextId`.
- `<img src="/...">` → `chrome.runtime.getURL("sidepanel/assets/<file>")` everywhere in this file
  (via a small local `asset(name)` helper — matches the existing codebase convention of inlining
  `chrome.runtime.getURL(...)` calls directly; the helper is just to avoid repeating the
  `"sidepanel/assets/"` prefix six times in one file, not a new architectural pattern).

### `ProducerTagRecorder.tsx` (re-skinned per the task's own instruction)
`NudgeVaultPanel.tsx`'s design only depicts this widget's **idle** state (a single static
`ButtonLarge` reading "Record New Audio Nudge") — the recording/preview/error states this
component's existing state machine actually needs have no design frame to transplant. Per Decision
5/9's established precedent for undesigned surfaces (composed fresh from the design system's own
tokens/primitives, not carried forward from any old plain-CSS predecessor), every button in this
widget now renders as a shared `ButtonLarge`, with a small new co-located
`ProducerTagRecorder.module.css` (not under `styles/frontend-backup/`, since nothing was ported from
there — mirrors `RequestUnlockForm.module.css`'s precedent) providing layout only. Every literal
button/status string (`"Record a tag (Xs max)"`, `"Stop"`, `"Discard"`, `sendLabel`/`"Sending…"`,
`"Recording… Xs / Ys"`, `"Open a tab to grant access"`) is preserved exactly, so its own test file's
text-based queries keep resolving the same content.

## Deviations from the plan's literal text (and why)

1. **The written-nudge textbox row stays a `<div>` with a manual `onKeyDown` Enter handler on the
   input, not a `<form onSubmit={...}>`.** Tasks 4/9 promoted analogous "textbox + submit icon" rows
   to a real `<form>`, relying on the browser's native "Enter in a text field implicitly submits the
   form" behavior. I tried that here first and it broke the existing
   `"submits on Enter, same as clicking Add"` test: jsdom/Testing Library's `fireEvent.keyDown(...,
   { key: "Enter" })` does **not** simulate a real browser's native implicit-submission default
   action (jsdom doesn't run that piece of the HTML forms processing model), so the test's
   `createSpy` was never called and it timed out. Since `handleAddText` takes no event parameter and
   this exact interaction already had real, working test coverage exercising it via `fireEvent.keyDown`
   (not `fireEvent.submit`), switching to a `<form>` would have required either changing that test's
   simulation mechanism (weakening what it actually verifies about the Enter-key interaction) or
   silently losing coverage. Instead: extended `TextInput` with an additive, optional `onKeyDown`
   prop (`snufflestudy/src/sidepanel/ui/TextInput.tsx` — same extension pattern as its existing
   `value`/`onChange`/`ariaLabel` additions from Tasks 7/9) and kept the exact original mechanism
   (manual `onKeyDown` on the input calling `handleAddText()` on Enter, button stays `type="button"`
   with `onClick={handleAddText}`). Confirmed via the passing, **unmodified**
   `"submits on Enter, same as clicking Add"` test — zero test changes needed for this file's
   behavior once reverted.
2. **`ProducerTagRecorder.test.tsx` needed two `getByText(...).toBeDisabled()` assertions changed to
   `getByRole("button", { name: ... }).toBeDisabled()`.** `ButtonLarge` always nests its button text
   inside an `<h3>`; `getByText("Sending…")`/`getByText("Send")` now resolves to that `<h3>`, and
   jest-dom's `toBeDisabled()` only recognizes bona fide form controls (a `<h3>` always reports
   "not disabled" regardless of its ancestor `<button>`'s real state). Fixed by querying the actual
   `<button>` via role instead — same behavior verified (the Send control really is disabled while
   sending / while `sendDisabled`), not weakened. Every other assertion in this file (9 of 11 tests)
   needed zero changes.
3. **The written-nudge check-icon uses a raw `<img>`, not the `ButtonBoolIcon` component**, even
   though `NudgeVaultBox.tsx` (like several other re-skinned components) has a `ButtonBoolIcon`-shaped
   spot in its design. Confirmed by reading `NudgeVaultPanel.tsx`'s actual source: this specific
   instance is a bare `<img className={styles.buttonBoolIcon} src="/button-check.svg" />`, not a
   `<ButtonBoolIcon>` component call — matching `FriendsBox.tsx`'s identical "Add Friend" check-icon
   (also a raw `<img>` in its own design source, also wrapped in a real button with a `*Reset` CSS
   class in Task 9). Where the design source *does* call `<IconButton icon="..." label="..." />`
   directly (the audio Play/Delete and written Edit/Delete icons), the shared `IconButton` component
   was used instead, per that same "read the actual source, don't assume every icon-shaped spot uses
   the same primitive" principle.
4. **Kept the existing hint placeholder `"e.g. You've got this!"` on the written-nudge textbox**
   rather than adopting the design's own (non-existent) placeholder. `NudgeVaultPanel.tsx`'s
   `<TextInput>` call for this field passes **no `placeholder` prop at all** (confirmed by reading
   the source — unlike Task 4's Task-Vault textbox, which explicitly specifies `placeholder="Textbox"`
   and was adopted per "design copy wins"). Since there's no literal design text to adopt here, and
   dropping the existing, genuinely useful hint would be a real UX regression with no design mandate
   either way, the pre-existing placeholder was kept.

## CSS additions (`NudgeVaultPanel.module.css`, small, commented, following the established precedent)

- `.buttonBoolIconReset` (+`:disabled`) — chrome-reset for the now-real written-nudge submit
  `<button>`, identical recipe to `FriendPanel.module.css`'s `.buttonIconReset` (Tasks 2, 4, 5, 9).
- `.exampleListItems` gained `list-style: none; margin: 0; padding: 0;` — now a real `<ul>` (was a
  plain `<div>` in the design), same precedent as Tasks 4/8/9.
- `.nudgeItemDetails` gained `flex: 1; min-width: 0;` and `.egNudgeOne` gained ellipsis rules
  (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`) — a real written-nudge body or
  clip-length label (unlike the static "E.g., nudge one" placeholder) can be arbitrarily long and
  must truncate rather than push the Edit/Delete icons off the row; `.buttonListIcon` gained
  `flex-shrink: 0` so it doesn't get squeezed. Same rationale/pattern as Task 9's `.taskDetails`/
  `.egTaskOne` addition in `FriendPanel.module.css`.

## New file: `ProducerTagRecorder.module.css`

Co-located next to `ProducerTagRecorder.tsx` (not under `styles/frontend-backup/`). Provides layout
only (`.recorder`/`.recordingRow`/`.previewRow` flex columns, `.status` text styling matching
`NudgeVaultPanel.module.css`'s own Shantell Sans/darkgray type scale, `.previewRow audio { width:
100% }`) — every actual button is a shared `ButtonLarge`. See its own header comment for the
"originated, not transplanted" rationale (mirrors `RequestUnlockForm.module.css`'s Task 7 precedent).

## Old CSS/classnames removed

- `nudge-vault-box`/`nudge-vault-box__audio`/`__written` (plain string classnames on the old JSX) are
  gone. Grep-confirmed **zero** CSS rules ever existed for them anywhere (pure JSX hooks, like
  `session-setup-form`/`task-vault-page` in Task 4) — nothing to delete beyond the JSX itself.
- `producer-tag-recorder`/`producer-tag-recorder__recording`/`__preview` (same situation — zero
  backing CSS rules anywhere, grep-confirmed) are gone from `ProducerTagRecorder.tsx`.
- `grep -rn "nudge-vault-box" snufflestudy/src` → zero matches.
- `grep -rn "producer-tag-recorder" snufflestudy/src` → zero matches outside this task's own
  explanatory comment in `ProducerTagRecorder.module.css`'s header (not live code).

## Open item: the written-nudge "Edit" icon is present but not wired

Confirmed via direct code read of `shared/messages.ts`: only `NUDGE_VAULT_TEXT_CREATE`,
`NUDGE_VAULT_TEXT_LIST`, and `NUDGE_VAULT_TEXT_DELETE` exist — **no `NUDGE_VAULT_TEXT_UPDATE`**
message anywhere in this codebase. Per the task's own instruction, the Edit `IconButton` is rendered
(`icon-edit.svg`, accessible name "Edit") with **no `onClick` prop at all** — clicking it does
nothing; no update flow was invented. This is called out in three places for anyone auditing later:
a comment in `NudgeVaultBox.tsx`'s own file header, a comment directly above the `<IconButton
icon={asset("icon-edit.svg")} label="Edit" />` call site, and a dedicated test
(`"shows a non-functional Edit control (no NUDGE_VAULT_TEXT_UPDATE message exists yet)"` in
`NudgeVaultBox.test.tsx`) asserting the control renders and that clicking it triggers **zero**
`sendMessage` calls. This is also named in the plan's own Whole-version Definition of Done as the
one item that stays explicitly flagged rather than resolved — restating it here as requested: **the
Nudge Vault's non-functional "edit" icon (Task 10) is an accepted, logged open item, not a defect.**

## What was verified, and how

- **`npm run compile` (`tsc --noEmit`)** — clean.
- **`npm run build` (`wxt build`)** — succeeds. Output listing confirms
  `sidepanel/assets/{icon-play-pause,icon-trash,icon-edit,button-check,bullet-dot}.svg` all land at
  the exact paths this task's `chrome.runtime.getURL(...)` calls expect.
- **`npx vitest run` on the touched files**:
  - `NudgeVaultBox.test.tsx` — **9/9 passing**, with **zero existing assertions changed** (only one
    net-new test added, the Edit-is-non-functional contract above). Every pre-existing behavior this
    file verifies — recording+saving an audio nudge (calls `PRODUCER_TAG_UPLOAD`, re-fetches, shows
    the new clip), lazy Play-then-`<audio>` swap, audio Delete (`PRODUCER_TAG_DELETE` + list update),
    written-nudge Add disabled-while-empty + `NUDGE_VAULT_TEXT_CREATE` + field-clear, Enter-to-submit,
    written-nudge Delete (`NUDGE_VAULT_TEXT_DELETE` + list update), and refresh-registry
    registration — passed **unmodified**, confirming both lists still load, save, and delete
    independently and immediately, exactly as before.
  - `ProducerTagRecorder.test.tsx` — **10/10 passing**, with exactly the two `getByRole` fixes
    described in Deviation 2 above (9 of 11 assertions/tests untouched).
- **Full suite, `npx vitest run`** — **92 files / 929 tests, all passing** (up from Task 9's stated
  baseline of 92/928 — net +1 test, the new Edit-contract test; no file added, no existing test
  removed or weakened).
- **Grep verification (all run directly, not assumed):**
  - `grep -rn "nudge-vault-box" snufflestudy/src` → zero matches.
  - `grep -rn "producer-tag-recorder" snufflestudy/src` → zero matches outside one explanatory
    comment (not live code).
  - `grep -n 'src="/' snufflestudy/src/sidepanel/components/NudgeVaultBox.tsx
    snufflestudy/src/sidepanel/components/ProducerTagRecorder.tsx` → zero matches (no unconverted
    absolute asset paths).
  - `grep -rn "NUDGE_VAULT_TEXT_UPDATE" snufflestudy/src` → the only hit is this task's own
    explanatory comment in `NudgeVaultBox.tsx`, confirming (not assuming) that no such message exists
    anywhere in `shared/messages.ts` or any API file.
- **Manual trace — audio/text independence unchanged**: `handleRecordAndSave`/`handleDeleteAudioTag`
  only ever touch `audioTags`/`saveAudioError`/`deleteAudioError`/`deletingAudioId`;
  `handleAddText`/`handleDeleteText` only ever touch `texts`/`saveTextError`/`deleteTextError`/
  `deletingTextId` — no shared state between the two halves, unchanged from before this task, and
  directly exercised by the passing per-half tests running against fully independent mock routing.
- **Cross-check — other consumers of `NudgeVaultBox.tsx`/`ProducerTagRecorder.tsx` unaffected**:
  grepped for every other file referencing either component (`FriendsTab.tsx`/`FriendsTab.test.tsx`,
  `SidePanelApp.test.tsx`). `FriendsTab.tsx` only mounts `<NudgeVaultBox />` with no props;
  `SidePanelApp.test.tsx`/`FriendsTab.test.tsx` only assert on the still-present `<h2>Nudge
  Vault</h2>` heading text, not on any removed classname — both passed unmodified in the full suite
  run. `ProducerTagRecorder` has exactly one caller (`NudgeVaultBox.tsx` itself, grep-confirmed) so
  its re-skin affects no other component.

## Definition of Done — status

**Fully passed.**
- `npm run compile` and `npm run build` succeed.
- `npx vitest run` — `NudgeVaultBox.test.tsx` passes with only one net-new assertion added (never
  weakening what's verified); recording+saving an audio nudge and adding a written one both work and
  appear in their respective lists immediately, each independently deletable — confirmed via the
  full set of passing, unmodified pre-existing tests. Full suite green at 92 files/929 tests (Task
  9's 92/928 baseline +1 new test).
- The written-nudge "edit" icon is present in the new markup and confirmed — via explicit code read
  (`shared/messages.ts` grep) and a dedicated test — **not** wired to any action; logged here and in
  the code as an explicit open item, not a silently-broken affordance.
- Grep confirms zero leftover `nudge-vault-box`/`producer-tag-recorder` classnames anywhere in
  `snufflestudy/src` (one explanatory comment excepted, not live code).

No blockers encountered.

## Files touched

- `snufflestudy/src/sidepanel/components/NudgeVaultBox.tsx` — re-skinned.
- `snufflestudy/src/sidepanel/components/NudgeVaultBox.test.tsx` — one net-new test added (Edit
  non-functional contract); zero existing assertions changed.
- `snufflestudy/src/sidepanel/components/ProducerTagRecorder.tsx` — re-skinned (state machine
  untouched).
- `snufflestudy/src/sidepanel/components/ProducerTagRecorder.test.tsx` — two `getByText(...)
  .toBeDisabled()` assertions changed to `getByRole("button", {...}).toBeDisabled()` (see
  Deviation 2); 9 of 11 tests untouched.
- `snufflestudy/src/sidepanel/components/ProducerTagRecorder.module.css` — new file (co-located
  layout CSS for the undesigned recording/preview states).
- `snufflestudy/src/sidepanel/styles/frontend-backup/components/friends/NudgeVaultPanel.module.css`
  — additions (`.buttonBoolIconReset`, `.exampleListItems` list reset, `.nudgeItemDetails`/
  `.egNudgeOne`/`.buttonListIcon` truncation fixes).
- `snufflestudy/src/sidepanel/ui/TextInput.tsx` — additive optional `onKeyDown` prop (see
  Deviation 1); backward-compatible, no other call site affected.

## Notes for later tasks

- **`TextInput` now also supports an optional `onKeyDown` prop** — any later task needing a
  manual Enter-to-submit interaction that must stay testable via `fireEvent.keyDown` (rather than
  relying on jsdom's unimplemented native form-implicit-submission) can reuse this instead of
  re-deriving it.
- **Confirmed again**: when re-skinning a `frontend-backup` component, check whether a given
  icon-shaped spot in the design source literally calls a shared primitive (`IconButton`,
  `ButtonBoolIcon`, `ButtonLarge`, etc.) or is a raw `<img>`/`<div>` — the two look identical in a
  rendered screenshot but require different re-skinning treatment (shared component vs.
  raw-element-wrapped-in-a-real-button-with-a-`*Reset`-class). This task had one of each within the
  same file (`IconButton` for Play/Delete/Edit, raw `<img>` for the written-nudge check icon).
- **The Nudge Vault's "edit" icon remains an explicitly open item** for any future version that
  wants to add a real `NUDGE_VAULT_TEXT_UPDATE` message and wire it up — not attempted here, per the
  plan's own instruction not to invent new backend capability.
