# V4.2 Task 2 Report — Header + TabBar

## What was built

Re-skinned the app-shell `Header.tsx` and `TabBar.tsx` (both at
`snufflestudy/src/sidepanel/components/`) as `frontend-backup`'s `HeaderBar.tsx`/
`NavigationBar.tsx` design, mounted once at the shell level exactly as before (Decision 1 was
already satisfied by `SidePanelApp.tsx`'s existing structure — confirmed by reading it; no shell
changes were needed for this task).

### `Header.tsx`
- JSX replaced with `HeaderBar.tsx`'s markup, styled via the already-ported
  `snufflestudy/src/sidepanel/styles/frontend-backup/components/layout/HeaderBar.module.css`
  (Task 1's byte-identical copy of `frontend-backup/src/components/layout/HeaderBar.module.css` —
  diffed to confirm before use).
- Mascot image: `chrome.runtime.getURL("sidepanel/assets/Bunny-and-Book@2x.png")` (was
  `sidepanel/bunny-and-book.png`, a different, older asset — the new design uses
  `frontend-backup`'s own mascot image, per Task 1's asset convention).
- "Log In" button (frontend-backup's own copy has no hyphen, unlike the pre-v4.2 "Log-In") —
  bound to the existing `onSignInClick`, still gated on `loaded && !session`, unchanged logic.
- Two icon buttons in the `frame`: `icon-close.svg` is left non-interactive (plain `<div>`, no
  `onClick`) — there is no current equivalent action anywhere in the app for it, per the plan's
  explicit instruction not to invent one. `icon-refresh.svg` is now a real `<button
  aria-label="Refresh" onClick={refreshAll}>` (`refreshAll` from the existing `useRefreshAll()`),
  since `HeaderBar.tsx`'s own version of this icon is just an inert `<div>` with no button
  semantics at all (frontend-backup is 100% static, per the plan's own framing) and this one
  needed real click + accessible-name semantics to preserve current behavior/testability.
- All `<img>` paths converted to `chrome.runtime.getURL("sidepanel/assets/<file>")` per Task 1's
  convention (`icon-close.svg`, `icon-refresh.svg`, `Bunny-and-Book@2x.png`).

### `TabBar.tsx`
- JSX replaced with `NavigationBar.tsx`'s markup, using the `ButtonTab` primitive
  (`snufflestudy/src/sidepanel/ui/ButtonTab.tsx`, from Task 1) for each tab's visual, styled via
  the ported `styles/frontend-backup/components/layout/NavigationBar.module.css`.
  `NavigationBar.tsx`'s own `<Link>`/`react-router-dom` usage was dropped entirely (grep-confirmed
  zero matches, see Verification below) in favor of the existing
  `onClick={() => onSelect(id)}` pattern, wired onto a real `<button>` wrapping each `ButtonTab`.
- All of the current accessibility attributes were preserved on that wrapping `<button>`, on top
  of `ButtonTab`'s own (accessibility-free) markup: `role="tablist"` on the container,
  `role="tab"`/`aria-selected={id === active}`/`aria-controls="sp-tabpanel"`/`id="sp-tab-${id}"`
  on each tab button — unchanged from the pre-v4.2 version.

### CSS additions (small, and why)
Both `HeaderBar.module.css` and `NavigationBar.module.css` needed one small addition each,
clearly commented as v4.2 Task 2 additions not present in `frontend-backup`'s original files:
- `HeaderBar.module.css`: a new `.buttonIconReset` class (border/background/padding/margin/font
  reset + `cursor: pointer`), applied alongside `.buttonIcon` only on the refresh button. Needed
  because `HeaderBar.tsx`'s own icon slots are `<div>`s (no UA chrome to reset); turning the
  refresh one into a real `<button>` means resetting the browser's default button chrome, which a
  `<div>` never had.
- `NavigationBar.module.css`: `.tabLink` (already applied to each tab) gained
  border/background/padding/margin/font/cursor/width/display resets, for the same reason —
  `NavigationBar.tsx` originally applied this class to an `<a>` (via `<Link>`), which also has no
  UA button chrome; the app's `<button>` replacement does.
- Both are necessary because this codebase's `global.css` has a bare-element `button { background:
  ...; border: ...; padding: ...; }` rule (confirmed by reading it) that applies to every plain
  `<button>` unless a higher-specificity class overrides it — without these resets, the refresh
  icon and tab buttons would have picked up the app's generic grey button chrome on top of the new
  design's own visuals. Class selectors' specificity beats the bare-element rule, so these
  overrides are effective regardless of stylesheet load order.

### Old CSS removed
Deleted from `snufflestudy/src/styles/sidepanel.css`: `.sp-header`, `.sp-header__title`,
`.sp-header__mascot`, `.sp-header__login-button`, `.sp-header__refresh-button`, `.sp-tabbar`,
`.sp-tabbar__tab`, `.sp-tabbar__tab--active` (`.sp-tab-content`/`.sp-card` were left — still used
by `SettingsTab.tsx`, out of this task's scope). Also fixed two now-stale comments that referenced
the deleted classnames by name: one in `sidepanel.css` (near `.study-room-panel__tile--selected`)
and one in `global.css` (the bare-`button` rule's own comment) — reworded to describe the pattern
generically instead of pointing at classes that no longer exist.

## Deviations from the plan's literal text (and why)
1. **Button text "Log In" (frontend-backup's copy) instead of the pre-v4.2 "Log-In".** The plan's
   Scope section calls for `frontend-backup`'s design "pixel-for-pixel", and `HeaderBar.tsx`'s own
   JSX literally contains `<h3>Log In</h3>` — adopted as-is rather than preserving the old hyphen.
   `Header.test.tsx`'s name queries were updated from `/log-in/i` to `/log in/i` accordingly (see
   Verification — this is exactly the "test asserts old exact markup text" case the task
   instructions anticipated; the behavior it verifies, onSignInClick firing / visibility gating,
   is unchanged).
2. **Refresh icon promoted from inert `<div>` to a real `<button>` with `aria-label="Refresh"`,
   and tab items wrapped in a real `<button>` instead of `NavigationBar.tsx`'s `<Link>`.** Required
   for both actual click behavior and accessible names — `frontend-backup`'s own markup is 100%
   static (per the plan's own description), so neither of these elements had real interaction
   semantics to carry forward as-is.
3. **Close icon kept as a plain, non-interactive `<div>`** — exactly per the plan's instruction,
   not converted to a button since it has no wired action.

No other deviations. `HeaderBar.module.css`/`NavigationBar.module.css` are otherwise untouched
from Task 1's byte-identical copies (diffed against `frontend-backup/src/components/layout/*` to
confirm before editing).

## What was verified, and how
- **`npm run compile` (`tsc --noEmit`), inside `snufflestudy/`** — clean.
- **`npm run build` (`wxt build`), inside `snufflestudy/`** — succeeds. Output listing confirms
  `sidepanel/assets/icon-close.svg`, `sidepanel/assets/icon-refresh.svg`, and
  `sidepanel/assets/Bunny-and-Book@2x.png` all land at the exact paths the new
  `chrome.runtime.getURL(...)` calls expect.
- **`npx vitest run` on `Header.test.tsx` + `TabBar.test.tsx`** — 7/7 pass.
  `TabBar.test.tsx` needed zero changes (the wrapping `<button>`'s accessible name still resolves
  to the tab label text via its flattened text content, so `getByRole("tab", { name: "Bunny" })`
  etc. and the `onSelect` click assertion both still work against the new markup unmodified).
  `Header.test.tsx` needed only the "Log-In" → "Log In" text-match updates described above; every
  assertion it made (onSignInClick fires, Log In shown/hidden based on `loaded`/`session`, exactly
  one Refresh button exists, clicking Refresh doesn't throw) is preserved unweakened.
- **Full suite, `npx vitest run`** — 89 test files / 892 tests, all passing (same totals as Task
  1's baseline — confirms nothing elsewhere regressed).
- **Grep verification:**
  - `grep -rn "sp-header\|sp-tabbar" snufflestudy/src` → zero matches (old classnames fully
    removed, JSX and CSS both).
  - `grep -n "Link\|react-router-dom" snufflestudy/src/sidepanel/components/TabBar.tsx` → zero
    matches.
- **Manual trace (read-only, no browser available in this environment):**
  - Tab click → `aria-selected` update: `TabBar.tsx`'s button has
    `onClick={() => onSelect(id)}` and `aria-selected={id === active}`; `SidePanelApp.tsx` passes
    `active={activeTab} onSelect={setActiveTab}`, so a click re-renders with the new tab's
    `aria-selected="true"`. Confirmed unchanged from pre-v4.2 wiring, and covered by
    `TabBar.test.tsx`'s passing "calls onSelect with the clicked tab" test.
  - Log In → Settings → Account: `SidePanelApp.tsx` line 99 wires
    `onSignInClick={() => setActiveTab("settings")}` (and again at line ~156 for the
    active-session branch). `activeTab === "settings"` renders `<SettingsTab
    onSettingsChange={setSettings} />`, whose own JSX (`snufflestudy/src/sidepanel/components/
    SettingsTab.tsx`) renders `<SettingsPage />`, `<AccountPage />`, and `<HistoryPage />` all
    stacked in one scrolling view (v4.1 Task 10's design — no separate sub-nav) — so switching to
    the Settings tab does land on a view containing Account. Confirmed by reading both files
    directly, not assumed.
  - Refresh → `refreshAll()`: `Header.tsx`'s refresh button has `onClick={refreshAll}`, where
    `refreshAll` is `useRefreshAll()`'s return value, unchanged from before this task's edit.

## Definition of Done — status
**Fully passed.** No blockers, no open items requiring the orchestrator's decision.

## Notes for later tasks
- `global.css` has a bare-element `button { ... }` rule that visually styles every plain
  `<button>` in the app (grey background/border/padding) unless overridden by a higher-specificity
  class. Any later task that turns a `frontend-backup` `<div>`/`<a>` into a real `<button>` for
  interactivity (several are expected, per Decision 6 and various "wire real semantics" steps)
  will likely need the same kind of small button-chrome-reset addition to that component's ported
  `.module.css` that this task added to `HeaderBar.module.css` (`.buttonIconReset`) and
  `NavigationBar.module.css` (`.tabLink`'s extra rules) — otherwise the global rule's chrome shows
  through underneath the intended design.
- `IconButton` (`snufflestudy/src/sidepanel/ui/IconButton.tsx`, from Task 1) was deliberately
  **not** used for the header's icon buttons, even though it's visually near-identical to
  `HeaderBar.tsx`'s own inline `buttonIcon`/`iconShape`/`vectorIcon` markup and is used for the
  same `icon-close.svg`/`icon-refresh.svg` assets elsewhere in `frontend-backup` (e.g.
  `DefaultFooter.tsx`). Reason: `HeaderBar.tsx`'s own file inlines the pattern by hand rather than
  importing `IconButton`, and its two icons have different, per-icon percentage-based sizes
  (`vectorIcon`/`vectorIcon2`, asymmetric aspect ratios) that `IconButton`'s generic fixed 16x16
  `<img>` doesn't reproduce — using `HeaderBar.tsx`'s own literal markup was the more
  pixel-accurate choice for this specific component, per the plan's "pixel-for-pixel" framing.
  Also, `IconButton.tsx` as ported has no `onClick` prop — a task that does want to reuse it for a
  clickable icon button will need to add one (a small, low-risk extension, not attempted here
  since it wasn't needed for this task's markup).
