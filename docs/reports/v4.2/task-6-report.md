# V4.2 Task 6 Report — Study Room footer

## What was built

Re-skinned `snufflestudy/src/sidepanel/components/StudyRoomFooter.tsx` as `frontend-backup`'s
`StudyRoomFooter.tsx`/`StudyRoomCallPanel.tsx`/`VideoBox.tsx` design. Every hook, handler, and
`sendMessage()` call already in the file is unchanged in behavior — only the JSX `return (...)`
block and the internal `StudyRoomVideoTile` tile's JSX changed; both effects that append
`tile.videoElement`/`tile.audioElement` into the tile's own container via ref are byte-identical
to before.

Per Task 1's own scaffolding convention, `VideoBox`/`StudyRoomCallPanel` were never ported as
separate component files (only their CSS Modules were, in Task 1) — like every other "remaining"
frontend-backup component in this plan, their markup is grafted directly into the one file being
re-skinned. `StudyRoomVideoTile` (already an internal, non-exported function in this file) **is**
this file's `VideoBox` usage; no new component file was created.

### `StudyRoomFooter.tsx`
- Outer wrapper is now `StudyRoomFooter.tsx`'s design (`<div className={styles.studyRoomFooter}>`,
  `<h1 className={styles.egStudyRoom}>{joinedRoom.name}</h1>`).
- `StudyRoomCallPanel`'s markup is inlined directly below: `callOptions` holds the mic/camera
  toggles and the Leave button; `exampleListItems` holds the video tiles; `buttonNudge` holds the
  Nudge button + vault picker.
- Mic/camera icons are now real toggle buttons (`aria-pressed={micOn|cameraOn}`, accessible names
  `"Microphone"`/`"Camera"`), swapping between the on/off asset pairs
  (`button-mic-on.svg`/`button-mic-off@2x.png`, `button-camera-on.svg`/`button-camera-off@2x.png`)
  — identical convention to Task 5's `StudyRoomsBox.tsx` toggles, bound here to the *live-call*
  `toggleCamera`/`toggleMic` (not Task 5's pre-join local-only camera/mic state).
- "Leave Study Room" (design's own copy, replacing pre-v4.2's "Leave room") calls
  `() => void leaveRoom()`, `disabled={leaving}`, label swaps to "Leaving…" while in flight — same
  loading-label-over-static-design-text precedent as Task 5's "Joining…"/Task 4's "Starting…".
- Each `VideoBox` is `StudyRoomVideoTile`'s new rendering: the same `containerRef`-based
  `appendChild`/`remove()` effects (keyed on `tile.videoElement`/`tile.audioElement`) mount the
  tile's real media elements into the `.videoBox` div, unchanged from the pre-v4.2 mechanism.
  `VideoBox`'s own `property1` variant prop is now driven by
  `selectedParticipantIds.has(tile.participantIdentity)` (`"selected"`/`"default"`), in addition to
  `aria-pressed` (both asserted in tests — see below). The local ("You") tile's guard is
  byte-identical to before: `onToggle` is `null` for `tile.isLocal`, and the container's
  interactive attributes (`role`, `tabIndex`, `aria-pressed`, `onClick`, `onKeyDown`) are added via
  a conditional object spread — when `onToggle` is `null`, **none of those attributes exist on the
  element at all**, not merely a no-op handler. `TextSmall` (Task 1's ported primitive) replaces
  the old `<span className="study-room-panel__tile-label">` for the name label.
- The Nudge button keeps its design-literal visible text ("Nudge"), but carries an `aria-label`
  reflecting the same dynamic string the pre-v4.2 button showed as its *visible* text
  (`"Nudge (N selected)"` / `"Sending…"`) — preserves the exact same accessible name (and thus the
  exact same `getByRole("button", { name: /^nudge \(n selected\)$/i })` test-query convention) while
  matching the design's static visible copy. `disabled` logic
  (`nudging || !selectedVaultKey || selectedParticipantIds.size === 0`) is unchanged.
- The design's "Dropdown" placeholder + chevron `<img>` is now a real `<select>`
  (`aria-label="Nudge Vault item"`, replacing the pre-v4.2 `<label>` wrapper with the same
  accessible name — `getByLabelText` resolves an `aria-label` identically to an associated
  `<label>`, so no test needed to change for this), bound to `selectedVaultKey`/`setSelectedVaultKey`,
  populated from `useNudgeVaultItems()`'s merged list exactly as before. All four pre-existing
  vault-loading branches (error / loading-with-empty-list / loaded-and-empty / has-items) are
  preserved 1:1 — only the "has-items" branch's markup changed (real `<select>` + chevron icon
  inside the design's `.input` wrapper, in place of the old bare `<select>`).
- `mediaError`'s alert (`role="alert"`, actionable "Open a tab to grant access" button calling
  `openMediaPermissionTab`) is unchanged — see "Deviations" below for why it's still unstyled.
- Every `<img src="/...">` converted to `chrome.runtime.getURL("sidepanel/assets/<file>")`.

## CSS additions (all new, commented, following the Task 2–5 `*Reset`-class precedent)

- **`StudyRoomCallPanel.module.css`**:
  - `.buttonLargeIconReset` — chrome reset for the now-real mic/camera toggle `<button>`s, identical
    pattern to Task 5's own `.buttonLargeIconReset` in `StudyRoomsPanel.module.css`.
  - `.dropdown` — select-chrome reset (`appearance: none`, border/outline/background reset,
    `width: 100%`, `cursor: pointer`), identical pattern to Task 4's `.dropdown` reset in
    `StudySessionSetupPanel.module.css` — needed since `.dropdown` was a plain, unstyled-by-itself
    `<div>Dropdown</div>` in the static design.
- **`VideoBox.module.css`**:
  - `.videoBox` gained `position: relative; overflow: hidden;` — the static design never held a
    real `<video>`/`<audio>` element, so it never needed either; both are required now so the
    absolutely-positioned media element clips to this box's own border-radius and anchors to this
    box, not the page.
  - `.videoBox { cursor: default; }` / `.videoBox[role="button"] { cursor: pointer; }` — replicates
    the pre-v4.2 `.study-room-panel__tile`/`--unselectable` cursor split, keyed off the same real
    signal the JSX itself uses (presence of `role="button"`), not a separate modifier class.
  - `.videoBox[data-property1="selected"] { outline: 3px solid var(--color-mistyrose-100); outline-offset: 2px; }`
    — `VideoBox.tsx`'s own `property1` variant prop has **no visual rule for "selected" anywhere in
    frontend-backup's source** (confirmed by reading `VideoBox.module.css` before editing — a
    static mockup never demonstrated the selected state). Added an outline treatment matching the
    pre-v4.2 `.study-room-panel__tile--selected` behavior, in this design's own color vocabulary
    (mistyrose — the same family `ButtonTab.module.css` uses for its own "selected" tab state, per
    Task 2).
  - `.videoBox :global(.study-room-panel__media) { position: absolute; inset: 0; z-index: 0; }` +
    `.videoBox > * { position: relative; z-index: 1; }` — positions the appended media element
    full-bleed behind the `TextSmall` label. Uses CSS Modules' `:global()` escape hatch to target
    `study-room-panel__media` (a **global, non-module** classname — see "Old CSS" section below)
    scoped to just this component's own tiles, rather than editing the shared global rule.
    Specificity note: `.videoBox :global(.study-room-panel__media)` (two classes, 0,2,0) beats
    `.videoBox > *` (one class + universal, 0,1,0) regardless of source order, so the media element
    reliably gets `position: absolute`/`z-index: 0` even though both rules technically match it.

No changes were needed in `StudyRoomFooter.module.css` (no buttons live there — just the `<h1>`
heading wrapper).

## Old CSS/markup removed — and the one thing deliberately kept

- **`snufflestudy/src/styles/sidepanel.css`**: deleted `.study-room-panel__grid`,
  `.study-room-panel__tile`, `.study-room-panel__tile--selected`,
  `.study-room-panel__tile--unselectable`, and `.study-room-panel__tile-label` — grep-confirmed
  (before deleting) that `StudyRoomFooter.tsx`'s own now-replaced JSX was the **only** place any of
  these five classnames were referenced anywhere in `snufflestudy/src`.
- **`.study-room-panel__media` was deliberately left in `sidepanel.css`, unmodified** — it is
  **not** assigned by `StudyRoomFooter.tsx`'s own JSX at all. `StudyRoomSessionContext.tsx` (the
  shared study-room session provider, out of this task's scope) calls
  `event.element.classList.add("study-room-panel__media")` directly on every `<video>`/`<audio>`
  element the moment it's created (confirmed by reading that file, line 153), independent of
  whatever markup the footer wraps it in. This class continues to do real work after this task
  (it's how the media element gets `width/height: 100%; object-fit: cover`) — `VideoBox.module.css`
  layers its own `position: absolute`/`z-index` on top via `:global()` rather than duplicating or
  replacing it. Confirmed via a targeted grep that every other `study-room-panel*` hit remaining
  anywhere in `snufflestudy/src` is either this live, intentionally-kept class or a historical
  comment referencing the old classnames by name for context (this task's own new comments, plus
  pre-existing ones in `StudyRoomsPanel.module.css`/`StudyRoomFooter.tsx`'s own header comment) —
  none are live selectors on dead markup.
- There was no CSS for the base `.study-room-panel`/`--footer`/`__header`/`__media-toggles`/`__nudge`
  classnames the old JSX also used (bare structural hooks with zero styling, same situation Task 5
  found for `StudyRoomsBox.tsx`'s own now-removed classnames) — nothing to delete there beyond the
  JSX itself.

## Deviations from the plan's literal text (and why)

1. **Nudge button keeps a static "Nudge" as its visible text; the dynamic
   "(N selected)"/"Sending…" state moves to `aria-label` instead of visible text.** The design's
   own literal copy is just "Nudge" with no count. Moving the count to `aria-label` preserves the
   exact same accessible-name string (and thus every existing
   `getByRole("button", { name: /^nudge \(n selected\)$/i })` test query, unchanged) while matching
   the design's static visible copy — a smaller, more surgical deviation than either dropping the
   count entirely or keeping the pre-v4.2 visible text verbatim.
2. **"Open a tab to grant access" (the `mediaError` actionable alert's button) is still a bare,
   unstyled `<button>`, not rebuilt from the design system.** This is a pre-existing, pre-v4.2
   plain button (it predates this whole re-skinning effort) with no `frontend-backup` equivalent
   anywhere (a static mockup has no error-state markup) — the same category of gap Decision 5
   (`RequestUnlockForm`) and Task 12 (delete-account confirmation) are, but unlike those two, Task
   6's own plan text does not call this specific corner out for a fresh from-the-design-system
   build. Left unstyled rather than guessing at a design for it, flagging it here per the Global
   Constraint's "no old-frontend styling survives, including undesigned surfaces" language — this
   is arguably in scope for a future task/pass to give real styling, but doing so here would be
   inventing a design Task 6 was never asked to invent.
3. No other deviations. `useStudyRoomSession()`'s destructured values, `useDisplayNames()`,
   `useNudgeVaultItems()`, `useRegisterRefresh()`, and `handleNudge()`'s entire body are unmodified
   byte-for-byte; only `return (...)` (both in `StudyRoomFooter` and in `StudyRoomVideoTile`) and
   the CSS Module imports changed.

## Test updates (`StudyRoomFooter.test.tsx`)

No assertion was weakened — every change tracks an intentional markup/copy change:
- `joinSampleRoom()`'s wait-for-join helper: `findByText("Leave room")` →
  `findByRole("button", { name: "Leave Study Room" })` (button copy changed).
- "renders nothing when no room is joined": `queryByText("Leave room")` →
  `queryByRole("button", { name: "Leave Study Room" })`.
- "toggles a tile's selected state..." (renamed to mention `property1` too): now also asserts
  `data-property1` goes `"default"` → `"selected"` → `"default"` alongside the existing
  `aria-pressed` assertions — strictly additive, verifying the new `VideoBox` variant prop the plan
  specifically calls out, not just its `aria-pressed` proxy.
- "mid-room: clicking the Camera toggle...": rewritten from text-based queries
  (`getByText("Camera: On"/"Camera: Off")`) to `getByRole("button", { name: "Camera" })` +
  `aria-pressed` assertions — same underlying behavior verified
  (`videoCallClient.setCameraEnabled(false)` called, toggle flips), new query mechanism matching
  the new icon-button markup.
- "leaves a room...": `getByText("Leave room")` → `getByRole("button", { name: "Leave Study Room" })`;
  the post-leave `queryByText`/assertion updated the same way.
- Stale-tile-cleanup describe block: same "Leave room" text query → "Leave Study Room" role query
  fixes.
- **`AppFooter.test.tsx`** (a third-party consumer test, not named in the plan's own file list —
  necessarily affected since it renders this task's re-skinned markup, same situation Task 4's
  report flagged for `StudyTab.test.tsx`/`SidePanelApp.test.tsx`): `findByText("Leave room")` →
  `findByRole("button", { name: "Leave Study Room" })`.
- No other test files needed changes (grep-confirmed — see Verification below).

## What was verified, and how

- **`npm run compile` (`tsc --noEmit`)** — clean.
- **`npm run build` (`wxt build`)** — succeeds. Output listing confirms
  `sidepanel/assets/{button-mic-on,button-mic-off@2x,button-camera-on,button-camera-off@2x,icon-chevron-down}`
  all land at the exact paths this task's `chrome.runtime.getURL(...)` calls expect (the first four
  already existed from Task 5; `icon-chevron-down.svg` already existed from Task 4 — none are new
  assets, all confirmed present in the build output).
- **`npx vitest run` on `StudyRoomFooter.test.tsx`** — 15/15 pass (one new assertion added to an
  existing test, no new test files).
- **Full suite, `npx vitest run`** — **90 files / 905 tests, all passing** — identical totals to
  Task 5's baseline (no new test files this task, since this is a pure re-skin of one existing
  component with no new sibling component created).
- **Grep verification (all run directly, not assumed):**
  - `grep -rn "study-room-panel" snufflestudy/src` → every hit is either the intentionally-kept,
    live `.study-room-panel__media` (assigned by `StudyRoomSessionContext.tsx`, styled in
    `sidepanel.css`, referenced via `:global()` in `VideoBox.module.css`) or a historical/explanatory
    comment naming the old classnames for context — zero live selectors on now-dead markup.
  - `grep -n 'className="' snufflestudy/src/sidepanel/components/StudyRoomFooter.tsx` → zero
    matches (every `className` is a CSS Module binding, no bare string classnames left).
  - `grep -n 'src="/' snufflestudy/src/sidepanel/components/StudyRoomFooter.tsx` → zero matches (no
    unconverted absolute asset paths).
  - `grep -rn "Leave room\|Camera: On\|Camera: Off\|Mic: On\|Mic: Off" snufflestudy/src` → zero
    remaining live references (one hit in an unrelated file's *comment*,
    `infrastructure/video/videoCallClient.test.ts:306`, describing behavior colloquially — not a
    query, not touched, out of this task's file scope).
- **Manual trace — DOM insertion mechanism unchanged:** `StudyRoomVideoTile`'s two `useEffect`s
  (keyed on `tile.videoElement`/`tile.audioElement`) are byte-identical to the pre-v4.2 version —
  same `containerRef.current`/`appendChild`/cleanup-`remove()` shape, now targeting the `.videoBox`
  div instead of the old `.study-room-panel__tile` div. Confirmed via the passing "mirrors the
  local video element..." and stale-tile-cleanup tests, which directly assert `element.isConnected`
  transitions.
- **Manual trace — Nudge send targeting:** `handleNudge()` is unmodified; confirmed via the passing
  written-nudge and audio-nudge send tests, which assert `NUDGE_SEND`/`PRODUCER_TAG_SEND_TO_FRIEND`
  are called with exactly the selected participants' `friendUserId`s, and that selection clears
  afterward.

## Definition of Done — status

**Fully passed.**
- `npm run compile` and `npm run build` succeed.
- `npx vitest run` — `StudyRoomFooter.test.tsx` passes with updated assertions reflecting the new
  markup; no assertion was weakened (video/audio DOM insertion, tile-click-toggles-selection-except-
  local-tile, and nudge-send-to-exactly-selected-participants are all still directly asserted). Full
  suite stays green at 90 files / 905 tests (Task 5's baseline, unchanged total).
- Joining a room shows this footer with the new design (confirmed via passing
  `getByRole("heading"...)`/structural assertions); clicking a non-local tile toggles both
  `aria-pressed` and `data-property1` (`"default"`↔`"selected"`); the local tile is confirmed
  non-clickable via a direct assertion that it carries no `role`/`aria-pressed`/`tabindex` attribute
  at all, not just a visual check.
- Selecting participants, picking a vault item, and pressing Nudge delivers to exactly those
  selected participants — confirmed via the unmodified `handleNudge()` logic and its passing tests.
- Grep confirms no leftover old classnames for this component anywhere in `snufflestudy/src`, and
  the `study-room-panel__*` question from Task 5's report is resolved: five classnames deleted
  (confirmed dead), one (`__media`) confirmed still genuinely live and correctly left alone.

No blockers encountered.

## Notes for later tasks

- **`.study-room-panel__media` is now referenced from a CSS Module via `:global(...)`** — the first
  use of that escape hatch in this codebase. If any later task also needs to layer CSS onto an
  element that carries this same global classname, `VideoBox.module.css`'s pattern
  (`.scopedParent :global(.study-room-panel__media) { ... }`) is the precedent to follow, rather
  than editing the shared `sidepanel.css` rule directly.
- **The "Open a tab to grant access" media-error button remains unstyled** (Deviation #2) — flagged,
  not silently left. If a future task/pass wants every remaining bare `<button>` given real design-
  system styling, this is one of the (likely few) remaining ones in the sidepanel tree.
- **The Nudge button's visible text is now static ("Nudge"/"Sending…"), with the selected-count
  signal moved to `aria-label`** — any future test or task touching this button should query by
  accessible name (`getByRole("button", { name: ... })`), not visible text, to see the count.
