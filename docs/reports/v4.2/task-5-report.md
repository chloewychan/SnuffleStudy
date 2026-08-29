# V4.2 Task 5 Report — Study Rooms box + access popup

## What was built

Re-skinned `snufflestudy/src/sidepanel/components/StudyRoomsBox.tsx` as `frontend-backup`'s
`StudyRoomsPanel.tsx` design, and built a new `StudyRoomAccessPopup.tsx` from `StudyRoomPopup.tsx`'s
design, replacing the old inline `ManageAccessSection`/`manageAccessRoomId` pattern per Decision 3.
Every hook, handler, and `sendMessage()` call already in `StudyRoomsBox.tsx` is unchanged in
behavior — only the JSX `return (...)` blocks, the deleted `ManageAccessSection` function, and a
new `openAccessPopupForRoomId` state (replacing `manageAccessRoomId`) changed.

### `StudyRoomsBox.tsx`
- JSX replaced with `StudyRoomsPanel.tsx`'s markup (`<section className={styles.studyRoomPanel}>`).
- Each room's `<button className={styles.buttonSmall}>` is now the real click-to-select control,
  bound to `setSelectedRoomId(room.id)` / `aria-pressed={selectedRoomId === room.id}`. Its
  `button-options.svg` icon (a sibling button, not nested inside the select button — no
  `stopPropagation()` needed, unlike the old nested-`<li>` layout) opens the new
  `StudyRoomAccessPopup` for that room, gated on the exact same `room.ownerUserId === selfUserId`
  check the old code used.
- The two camera/mic icons in `callOptionPanel` are now real toggle buttons
  (`aria-pressed={cameraOn|micOn}`, accessible names "Camera"/"Microphone") swapping between the
  provided on/off asset pairs (`button-camera-on.svg`/`button-camera-off@2x.png`,
  `button-mic-on.svg`/`button-mic-off@2x.png`, both already present from Task 1). "Join Study
  Room" binds to `handleJoinSelectedRoom`, `disabled={selectedRoomId === null || joining !== null}`,
  unchanged.
- Only the **first** `InputCreateStudyRoom` instance ("Create Study Room") is ported, wired to
  `newRoomName`/`handleCreateRoom` — its `<h3>` heading became a real `<label htmlFor="new-room-name">`
  (Task 3/4 precedent), its check-icon `<img>` became a real icon-only `<button>`
  (`aria-label="Create study room"`/`"Creating…"`). The second ("Join Study Room"/room-code)
  instance is not ported in any form — no unwired button, no hidden field, no dead import (Decision
  4, settled). **Grep-confirmed** (see Verification below).
- The signed-out branch (no `frontend-backup` design exists for it — a 100% static design has no
  auth concept) was also re-skinned, using this file's own `styles.studyRoomPanel`/`studySession`
  classes for visual consistency, since Task 14's own audit list checks for zero remaining
  `study-room-panel` (old plain-CSS) references anywhere in this file, including this branch.
- `<img src="/...">` converted to `chrome.runtime.getURL("sidepanel/assets/<file>")` everywhere in
  this file.

### New `StudyRoomAccessPopup.tsx`
Built from `StudyRoomPopup.tsx`'s markup. Props: `roomId: string`, `roomName: string`,
`onArchive: () => void`, `archiving: boolean`, `archiveError: string | null`, `onClose: () => void`
(the last two are additions beyond the plan's literal 4-prop list — see "Deviations" below).
- Fetches `STUDY_ROOM_INVITEES_LIST` for the given `roomId` on mount and whenever `roomId` changes;
  resolves each invitee's `userId` to a display name via `useDisplayNames` (same calling convention
  as the old `ManageAccessSection`: `useDisplayNames(ids)` returns a `(userId) => string` resolver).
  Renders one row per invitee (`egFriendOneParent`/`egFriendOne`) with a trash-icon `IconButton`
  calling `STUDY_ROOM_INVITEE_REMOVE`, removing that row from local state on success.
- **Per Decision 3 (settled): no add-toggle, no way to invite someone new from this popup, at
  all.** Only currently-invited friends are listed; no `FRIENDS_LIST` fetch and no
  `STUDY_ROOM_INVITEE_ADD` call exist anywhere in this component.
- "Archive Study Room" calls the passed-in `onArchive` prop, `disabled={archiving}`.
- Loading/empty/error states mirror the old `ManageAccessSection`'s own handling (`role="alert"`
  for errors, a plain loading/empty message otherwise).

## Presentation decision: modal overlay (not inline-expanded)

Built as a **fixed-position modal overlay** (`.overlayBackdrop` — `position: fixed; inset: 0`,
semi-transparent scrim, centers a `role="dialog" aria-modal="true"` card), dismissible **both** by
an explicit close (×) button and by a backdrop click (clicking the card itself does not close it,
via `stopPropagation()`).

Why: I checked for an existing overlay/modal convention elsewhere in this codebase's sidepanel
components before deciding (`grep -rn "modal\|overlay\|position: fixed"` across `snufflestudy/src`)
— the only hits are the *content-script* overlay (`src/content/overlay/*`, the injected
on-page Snuffles character), which is a different context entirely (a separate injected page, not
a sidepanel UI pattern) and not applicable here. With no existing sidepanel modal precedent to
match, I followed the plan's own stated default: `frontend-backup` treats `StudyRoomPopup` as a
standalone routed "page," which — now that routing is dropped per the Global Constraints — reads
most naturally as a modal overlay rather than an inline-expanded panel like the old
`ManageAccessSection`. A modal also avoids the layout-shift problem an inline expansion would cause
in a scrollable room list, and gives the popup room to breathe without fighting the room-select
button's own fixed-height row.

## Deviations from the plan's literal text (and why)

1. **Two additional `StudyRoomAccessPopup` props beyond the plan's literal 4 (`roomId`,
   `onArchive`, `archiving`, `archiveError`): `roomName: string` and `onClose: () => void`.**
   - `roomName`: `frontend-backup`'s own H1 slot (`"E.g., Study room"`) is clearly meant to show
     the specific room's name, the same way `"E.g., Friend One"` is meant to show a specific
     friend's name in the row below it. `StudyRoomsBox.tsx` already has the room object on hand
     when rendering this popup, so threading the name through is a low-risk, design-faithful
     addition rather than a generic/unlabeled title.
   - `onClose`: the plan's own Step explicitly asks for a "dismissible by an explicit close action
     or backdrop click" modal — that requires a callback into the parent's
     `openAccessPopupForRoomId` state, which nothing in the literal 4-prop list provides. Without
     it, the popup could never actually be dismissed except by archiving. Added as a plain
     `() => void`, following the same shape convention as `onArchive`.
2. **`IconButton.tsx` (Task 1's shared primitive) extended with optional `onClick`/`disabled`
   props.** It was ported from `frontend-backup` as a static, click-less `<button>` (no
   interactivity anywhere in the source design). This popup's trash icon is the first real call
   site needing it to actually do something; the extension is additive and backward-compatible
   (both props optional, omitting either reproduces the exact prior static behavior). Also added
   `.iconButton:disabled { opacity: var(--opacity-0_5); cursor: not-allowed; }` to
   `IconButton.module.css`, matching the `.saveButtonReset:disabled` precedent from Task 3. This
   should help later tasks that also need a real trash/remove icon (Task 9's `FriendOptionsPopup`,
   Task 10's `NudgeVaultPanel`, Task 11's `RestrictedSitesList`, Task 8's `DefaultFooter`) — they
   can now use the shared primitive directly instead of hand-rolling their own reset.
3. **The real "join the currently-selected room" button keeps its exact pre-v4.2 copy, "Join study
   room" — not `StudyRoomsPanel.tsx`'s own literal button text, "Join Study Room."** This is a
   deliberate, DoD-driven choice, not a missed pixel-for-pixel opportunity: the orchestrator's own
   required verification grep (`grep -rn "Room code\|room code\|JoinStudyRoom\|Join Study Room"
   .../StudyRoomsBox.tsx`, case-sensitive) is checking for exactly the text
   `frontend-backup`'s **removed, second** `InputCreateStudyRoom` instance uses for its own heading
   (`createStudyRoom="Join Study Room"`) — and by coincidence, the *legitimate* join button in the
   same file's design also happens to read the identical string `"Join Study Room"`. Adopting the
   design's literal capitalization for the real button would make the DoD's own grep produce a
   false positive on a legitimate, correctly-wired button, indistinguishable by text alone from the
   deleted feature. The DoD's own prose elsewhere ("Selecting a room and clicking 'Join study
   room' joins it, unchanged from today") also assumes the lowercase, pre-v4.2 phrasing survives.
   Kept the original text specifically to satisfy the letter of the DoD grep while keeping the
   button's real behavior/wiring identical; documented in both `StudyRoomsBox.tsx`'s own header
   comment and inline at the JSX site so a future editor doesn't "fix" it back to the design's
   literal copy and reintroduce the grep collision.
4. **"Create Study Room" (the create-room field's label) lost its visible button text**, becoming
   an icon-only checkmark button with `aria-label="Create study room"`/`"Creating…"` — same
   precedent as Task 4's Task Vault "Add task" button (a real, previously-text button becoming
   icon-only per the design, accessible name carried via `aria-label` instead of visible text).
5. **CSS additions** (all new, commented, following the Task 2–4 `*Reset`-class precedent, since
   `global.css` has a bare `button {...}` reset that would otherwise show through on any
   newly-real `<button>` that doesn't already define its own background/border/padding):
   - `StudyRoomsPanel.module.css`: `.buttonIconReset` (room options icon), `.buttonLargeIconReset`
     (mic/camera icons), `.buttonSmall[aria-pressed="true"] { opacity: 1; }` (selected-room look —
     the static design's own `opacity: 0.4` on `.buttonSmall` reads as its "not selected" look;
     this task treats that as the real unselected state rather than resetting it away),
     `.buttonLarge3:not(:disabled) { opacity: 1; }` / `:disabled { cursor: not-allowed; }` (same
     reasoning — the static `opacity: 0.4` maps naturally onto the Join button's real disabled
     state, since nothing is selected on first render), `.button6` gained
     `overflow/text-overflow/white-space` ellipsis rules since it now wraps a real, unpredictable
     room-name string instead of the static placeholder `"Button"`.
   - `InputCreateStudyRoom.module.css`: `.buttonBoolIconReset` (+ `:disabled` opacity), same
     pattern as `InputBunyName.module.css`'s `.saveButtonReset` from Task 3.
   - `StudyRoomPopup.module.css`: `.overlayBackdrop` (fixed scrim), `.popupHeader`/
     `.closeButtonReset` (new header row with a close icon — not in `frontend-backup`'s original
     markup, added because this is now a real dismissible modal instead of a routed page),
     `.buttonLarge:disabled` opacity. `.studyRoomPopup` changed from a full-width page section
     (`width: 100%`) to a capped, scrollable dialog card (`max-width: 420px; max-height: 100%;
     overflow-y: auto;`).
   - `IconButton.module.css`: `.iconButton:disabled` opacity (see deviation #2).

## Old CSS/markup removed

- **`ManageAccessSection` function and `manageAccessRoomId` state deleted entirely** from
  `StudyRoomsBox.tsx` (grep-confirmed zero live references — the two remaining hits for
  `manageAccessRoomId` are this task's own explanatory comments, not code).
- **`snufflestudy/src/styles/sidepanel.css`**: deleted `.study-room-panel__room` and
  `.study-room-panel__room--selected` — grep-confirmed these two selectors were exclusively used
  by the now-replaced room-list `<li>` ternary in the old `StudyRoomsBox.tsx`, nowhere else.
  **Left untouched**: `.study-room-panel__grid`, `.study-room-panel__tile`,
  `.study-room-panel__tile--selected`, `.study-room-panel__tile--unselectable`,
  `.study-room-panel__media`, `.study-room-panel__tile-label`, and the base
  `.study-room-panel`/`__header`/`__media-toggles` classnames — all still actively used by
  `StudyRoomFooter.tsx` (Task 6's scope, not touched by this task). No CSS rules existed for
  `study-room-panel__create`/`__sign-in`/`__list`/`__manage-access` in the first place (they were
  bare structural hooks with zero styling), so nothing to delete there beyond the JSX itself.
- Confirmed via `grep -rn "study-room-panel" snufflestudy/src` that every remaining hit is either
  `StudyRoomFooter.tsx`'s own live (untouched) usage or a historical comment in an unrelated file
  (`FriendsBox.tsx`, `friendshipApi.ts`, `shared/messages.ts`) referencing the old
  `ManageAccessSection` by name for context — not live code.

## What was verified, and how

- **`npm run compile` (`tsc --noEmit`)** — clean.
- **`npm run build` (`wxt build`)** — succeeds. Output listing confirms
  `sidepanel/assets/{button-options,button-mic-on,button-mic-off@2x,button-camera-on,button-camera-off@2x,button-check,icon-close,icon-trash}`
  all land at the exact paths this task's `chrome.runtime.getURL(...)` calls expect.
- **`npx vitest run` on the touched/new files** — `StudyRoomsBox.test.tsx` (33 tests, substantially
  rewritten — see below), `StudyRoomAccessPopup.test.tsx` (14 new tests), `StudyTab.test.tsx` (an
  unmodified third-party consumer, still passing unchanged) — all green.
- **Full suite, `npx vitest run`** — **90 files / 905 tests, all passing** (up from Task 4's
  baseline of 89/892 — net +13 from the new `StudyRoomAccessPopup.test.tsx` file plus a few added
  `StudyRoomsBox.test.tsx` cases, minus the removed old add/remove-toggle tests).
- **Grep verification (all run directly, not assumed):**
  - `grep -rn "Room code\|room code\|JoinStudyRoom\|Join Study Room"
    snufflestudy/src/sidepanel/components/StudyRoomsBox.tsx` → **zero matches** (confirmed after
    fixing both an early doc-comment and the button-copy collision described in Deviation #3).
  - `grep -n 'src="/' StudyRoomsBox.tsx StudyRoomAccessPopup.tsx` → zero matches (no unconverted
    absolute asset paths).
  - `grep -n "function ManageAccessSection\|manageAccessRoomId"` → only this task's own comments,
    no live code.
  - `grep -rn "study-room-panel"` (repo-wide) → only `StudyRoomFooter.tsx`'s own live, untouched
    usage and historical comments elsewhere.

## Test updates

- **`StudyRoomAccessPopup.test.tsx` (new, 14 tests):** loads/lists invitees via
  `STUDY_ROOM_INVITEES_LIST` with resolved display names; falls back to raw `userId` with no
  profile; passes the given `roomId` through and shows `roomName` as the title; load-error and
  empty-list states; **confirms no add-toggle/invite affordance and no `STUDY_ROOM_INVITEE_ADD`
  call exists anywhere** (Decision 3's central guarantee); removes an invitee via
  `STUDY_ROOM_INVITEE_REMOVE` and drops them from the list; keeps the invitee and shows an error on
  remove failure; disables + relabels Archive while `archiving`; calls the passed-in `onArchive`;
  shows a passed-in `archiveError`; closes via the close button and via backdrop click (but not via
  a click on the dialog card itself); re-fetches when `roomId` changes.
- **`StudyRoomsBox.test.tsx` (substantially rewritten):**
  - Copy-only fixups (no assertion weakened): `"New room name"` label → `"Create Study Room"`;
    `"Create room"` button → icon-only, queried by its `"Create study room"` accessible name;
    camera/mic checkboxes → toggle buttons, queried by `aria-pressed` instead of `.toBeChecked()`.
  - **Removed** the old `"StudyRoomsBox — Manage access (v3.3 Task 13)"` describe block entirely
    (its add/remove-toggle-against-every-friend behavior no longer exists per Decision 3 — its
    replacement coverage lives in `StudyRoomAccessPopup.test.tsx`).
  - **Rewrote** the Archive describe block to route through the popup: open the access popup via
    the room's options icon, then click "Archive Study Room" inside it; asserts the room leaves the
    list **and** the popup itself closes on success, and that both the room and the popup (with its
    error) remain on failure.
  - **Added** a new "access popup" describe block: options icon visible only for an owned room and
    absent for a room the user doesn't own; opening it shows a `role="dialog"` scoped to exactly
    that room (`aria-label`/heading both assert the specific room name); the close button closes
    it; opening a second owned room's popup while one is already open shows only the new one
    (`getAllByRole("dialog")` has length 1).
  - No assertion was weakened anywhere — every change either tracks an intentional copy/markup
    change (documented above) or narrows a query to disambiguate text that legitimately now
    appears twice (e.g. a room's name appearing in both its list row and an open popup's title).

## Definition of Done — status

**Fully passed.**
- `npm run compile` and `npm run build` succeed.
- `npx vitest run` — full suite 90/90 files, 905/905 tests green; `StudyRoomsBox.test.tsx` passes
  with updated assertions reflecting the new popup instead of inline `ManageAccessSection`;
  `StudyRoomAccessPopup.test.tsx` covers list/remove/archive as required.
- Selecting a room and clicking "Join study room" joins it, unchanged from today — confirmed via
  the passing "has no per-item Join button..." test, which traces the exact same
  `handleJoinSelectedRoom` → `joinRoom(room, { camera, microphone })` wiring, byte-identical to
  before this task.
- Clicking a room's options icon (owner only) opens the access popup showing exactly that room's
  current invitees, each removable; removing one updates the list — confirmed via passing tests in
  both files. Archiving removes the room from the list and closes the popup — confirmed via the
  rewritten Archive describe block's success-path assertions.
- `grep -rn "Room code\|room code\|JoinStudyRoom\|Join Study Room"
  snufflestudy/src/sidepanel/components/StudyRoomsBox.tsx` → **zero matches**, confirmed directly.

No blockers encountered.

## Notes for later tasks

- **`IconButton.tsx`/`IconButton.module.css` now support `onClick`/`disabled`** (Deviation #2) —
  Tasks 8 (`DefaultFooter`), 9 (`FriendOptionsPopup`), 10 (`NudgeVaultPanel`), and 11
  (`RestrictedSitesList`) can use the shared primitive directly for their own trash/remove-style
  icons instead of re-deriving a reset from scratch, if its existing `icon`/`label` prop shape fits
  their needs.
- **The "Join study room" button's copy is intentionally NOT `frontend-backup`'s literal text** —
  see Deviation #3. If a future task or design sync ever "corrects" this back to the design's
  literal `"Join Study Room"` capitalization, it will silently break the DoD grep this task (and
  presumably Task 14's own audit) relies on to catch a resurfaced join-by-code feature. Flagging
  this explicitly so it isn't undone by mistake.
- **No existing sidepanel modal/overlay convention existed before this task** — `StudyRoomAccessPopup`
  is the first one (`.overlayBackdrop`/`role="dialog"`/`aria-modal`/backdrop-click-to-close/explicit
  close button pattern, all in `StudyRoomPopup.module.css`). Task 9's `FriendOptionsPopup`
  (`FriendDetailsPopup.tsx`'s design) is the next component facing the identical
  routed-page-becomes-something question — it can reuse this exact pattern (backdrop + dialog +
  close button) for consistency rather than inventing a second modal convention.
- **`bullet-dot.svg`-style unresolved-path items from Task 1 are untouched** — not relevant to this
  task's files.
