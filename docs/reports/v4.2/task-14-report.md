# V4.2 Task 14 Report — Manual QA pass (automated audit + human handoff)

## Scope of this report

Per the plan's own Task 14, steps 2/3/4 require two real accounts, a real browser, and real
camera/mic permission prompts — genuinely not attemptable by an agent. This report covers
everything else: steps 1, 5, 6, 7, 8, plus the whole-plan sanity checks (final build/test run,
consolidated open-items list). The human-only steps are handed off as
`docs/qa/V4.2_Two_Account_QA_Script.md`, written in the same format as
`docs/qa/V4.1_Two_Account_QA_Script.md`.

---

## 1. Whole-plan sanity check: build + full test suite

Run from `snufflestudy/`, as the final check after Tasks 1–13:

- **`npm run compile`** (`tsc --noEmit`) — clean, no errors.
- **`npm run build`** (`wxt build`) — succeeds. `.output/chrome-mv3/` produced, 2.79 MB total,
  all expected entrypoints (`background.js`, `sidepanel.html`, `options.html`, `locked.html`,
  content script) present.
- **`npx vitest run`** — **92 test files / 929 tests, all passing.** Matches Task 13's stated
  final baseline exactly (92/929) — no regression introduced by anything since, including this
  task's own two fixes (re-ran after each).

This confirms the plan's own task-by-task self-reported counts (89/892 after Task 1 → 90/905
after Task 5 → 91/916 after Task 7 → 92/928 after Task 9 → 92/929 after Task 10, holding flat
through Task 13) are consistent with the real, current state of the repo — not just each task's
own claim in isolation.

---

## 2. Asset audit (plan's step 5)

Checked the built `.output/chrome-mv3/` output against every asset path referenced in
`snufflestudy/src/` — not just grepping source in isolation, per the instruction, since a missed
conversion fails silently as a broken image rather than a build error.

**Method:**
1. Collected every `chrome.runtime.getURL("sidepanel/assets/<file>")` literal call across
   `src/` (`grep -rhoE 'getURL\("sidepanel/assets/[^"]+"\)'`).
2. Collected every `asset(name)` helper indirection (`HistoryPage.tsx`, `NudgeVaultBox.tsx`,
   `SettingsPage.tsx` each define a local `function asset(name) { return
   chrome.runtime.getURL(\`sidepanel/assets/${name}\`); }`) — confirmed all three helpers use the
   correct prefix, then collected every filename passed into each.
3. Collected every multi-line/ternary `getURL(...)` call (`StudyRoomFooter.tsx`,
   `StudyRoomsBox.tsx`'s camera/mic on/off icon swaps) by reading them directly, since a
   single-line grep pattern would miss the wrapped filename.
4. Collected every `url(/sidepanel/assets/...)` reference in CSS Modules.
5. Diffed the full referenced-filename set against `ls .output/chrome-mv3/sidepanel/assets/`
   (19 files) after a fresh build.

**Result: clean, after one fix.** Every referenced filename resolves to a real file in the build
output — **except** one found and fixed (see below). Also confirmed **zero** remaining
`src="/..."` (unconverted absolute-path) references anywhere in `src/sidepanel/`/`src/options/`,
and zero `url(/...)` CSS references outside the `/sidepanel/assets/` convention, after the fix.

### Fixed: `ActiveSession.module.css`'s unnormalized `bullet-dot.svg` path

Task 1 copied `styles/frontend-backup/components/study/ActiveSession.module.css` byte-for-byte
with frontend-backup's own `background-image: url(/bullet-dot.svg)` (a root-relative path that
doesn't resolve inside a packed extension page), noting in its own report that this was safe
*because none of the four files carrying this pattern were wired into a live screen yet* — Task 1
also left a root-level `snufflestudy/public/bullet-dot.svg` duplicate specifically so this
unnormalized reference wouldn't break silently in the meantime. Tasks 4, 9, and 11 each later
wired up their own copy of this pattern and normalized it to
`url(/sidepanel/assets/bullet-dot.svg)`, per Task 1's own explicitly-sanctioned convention — but
Task 7 (which re-skinned `ActiveSessionView.tsx`, the file that actually mounts
`ActiveSession.module.css`) did not, and its own report doesn't mention touching this rule at all.

Confirmed via direct trace that `.buttonList` (the class carrying this background-image) **is**
live: `ActiveSessionView.tsx` lines 65 and 71 render
`<span className={styles.buttonList} aria-hidden="true" />` as the Activity/Focus status rows'
decorative bullet markers. So Task 1's original "not wired into a live screen yet" premise for
this specific file stopped being true the moment Task 7 landed, and nobody circled back to
normalize it.

It wasn't actually broken — the root-level `public/bullet-dot.svg` duplicate made it resolve —
but it was inconsistent with the convention every other task followed, and depended on a
duplicate file the plan intended as temporary scaffolding, not a permanent second copy.

**Fix applied** (mechanical, zero design judgment, verified safe):
- `snufflestudy/src/sidepanel/styles/frontend-backup/components/study/ActiveSession.module.css` —
  normalized `url(/bullet-dot.svg)` → `url(/sidepanel/assets/bullet-dot.svg)`, with a comment
  matching the convention Tasks 4/9/11 already established.
- `snufflestudy/public/bullet-dot.svg` — deleted (now unreferenced anywhere in `src/`, confirmed
  via `grep -rn "url(/bullet-dot" src/` returning zero matches after the fix).
- Re-ran `npm run build` (confirms `.output/chrome-mv3/bullet-dot.svg` no longer exists, and
  `.output/chrome-mv3/sidepanel/assets/bullet-dot.svg` still resolves) and `npx vitest run`
  (92/929, unchanged) — both clean.

---

## 3. Old-frontend audit (plan's step 6)

Grepped `snufflestudy/src/sidepanel/` and `snufflestudy/src/options/` for all 14 named prefixes,
in both JSX (`className="..."`) and CSS rule selectors:

`sp-header`, `sp-tabbar`, `sp-bunny-tab`, `session-setup-form`, `task-vault-page`,
`study-room-panel`, `sp-active-session`, `nudges-and-requests-footer`, `friends-box`,
`nudge-vault-box`, `settings-page`, `account-page`, `history-page`, `sp-app-footer`.

**12 of 14 are fully clean** — zero live references anywhere (only historical/explanatory
comments in a few files, correctly not live selectors), matching every task's own claim:
`sp-header`, `sp-tabbar`, `sp-bunny-tab`, `session-setup-form`, `task-vault-page`,
`sp-active-session`, `nudges-and-requests-footer`, `friends-box`, `nudge-vault-box`,
`settings-page`, `account-page`, `history-page`.

**1 of 14 (`study-room-panel`) is clean by design, not by omission** — confirmed against Task 5's
and Task 6's own claims: `.study-room-panel__media` is deliberately, correctly still live.
`StudyRoomSessionContext.tsx` (the shared data-layer provider, out of every task's scope) assigns
this classname directly via `classList.add(...)` on every video/audio DOM element it creates,
independent of whatever markup wraps it; `VideoBox.module.css` (Task 6) layers new-design
positioning onto it via a `:global()` escape hatch rather than replacing it. Every other
`study-room-panel__*` selector (`__room`, `__room--selected`, `__grid`, `__tile`,
`__tile--selected`, `__tile--unselectable`, `__tile-label`) is confirmed deleted.

**1 of 14 (`sp-app-footer`) is a genuine, unresolved discrepancy — flagged, not fixed.** See next
section.

### Finding: `AppFooter.tsx`'s `sp-app-footer` wrapper was never in any task's scope

`src/sidepanel/components/AppFooter.tsx` (the shell component that stacks `StudyRoomFooter` and
`NudgesAndRequestsFooter`) still renders `<div className="sp-app-footer">` — unchanged since
before this plan started. This file is **not** among the plan's 14 "surfaces" (it's absent from
the File Structure section's list, and no task's Deliverables name it) — it's framed only as
context/infrastructure, the same way `SidePanelApp.tsx` itself is. But unlike `SidePanelApp.tsx`'s
own shell classnames (`sidepanel-app`, `sp-sticky-header`, `sp-scroll-area`) and the tab-wrapper
files' `sp-card`/`sp-tab-content` (none of which appear in the audit list — a consistent,
deliberate scoping choice, repeatedly confirmed correct by Tasks 3/4/5/7's own reports),
**`sp-app-footer` is explicitly one of the 14 names the plan's own step 6 asks Task 14 to verify
is gone.** No task was ever assigned to make that true.

This isn't a dead, unstyled hook like most of the other 12 classnames every task found and safely
deleted. `sidepanel.css`'s `.sp-app-footer` rule (added by a v4.1 fix, commit `d90b629`, dated
*before* this v4.2 branch's Task 1) does real, visible work:

```css
.sp-app-footer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-top: 2px solid rgb(from var(--color-accent) r g b / 0.5);
  flex-shrink: 0;
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: var(--color-bg);
}
```

Two things are tangled together here:
- **Layout-critical, functional CSS** (`position: sticky; bottom: 0; z-index: 1; flex-shrink: 0`)
  — this is what keeps the footer pinned to the bottom of the scrollable panel, per commit
  `d90b629`'s own message ("Header+TabBar and the app footer are pinned to the top/bottom of a new
  flex-column shell"). This must not be removed or broken.
- **Old-vocabulary visual chrome** (`padding: var(--space-4)`, `gap: var(--space-3)`,
  `border-top: ... var(--color-accent) ...`, `background: var(--color-bg)`) — these are the
  pre-v4.2 token system (`src/styles/tokens.css`), still resolving fine, still rendering. Both
  re-skinned children now carry their own complete visual chrome from their own frontend-backup
  CSS Modules (`StudyRoomFooter.module.css`'s `.studyRoomFooter` has
  `background-color: var(--color-snow-100); padding: var(--padding-40); ...`;
  `DefaultFooter.module.css`'s `.defaultFooter` has the equivalent). So this wrapper's old
  padding/border/background is now redundant at best, and at worst renders as a visible tan-bordered
  cream bar sandwiching the new pink-and-cream footer cards — a real "old-frontend styling
  survives" case under the plan's own Global Constraint.

**Why this was flagged instead of fixed directly:** a correct fix has to (a) preserve the sticky
positioning exactly, since that's the subject of a very recent, deliberate fix outside this plan's
own history, and (b) make a real design-judgment call about what (if anything) the new-vocabulary
replacement padding/gap/border/background should be — there's no frontend-backup frame for "the
element that wraps two independent footer cards," so there's nothing to transplant, only something
to originate (the Decision-5/Decision-9 situation). That's exactly the "non-trivial, requires
judgment" case the instructions say to flag rather than guess at. Recommend a short, explicit
follow-up task: strip `.sp-app-footer`'s visual properties (padding/gap/border-top/background) down
to just the functional sticky-positioning ones, and let the two children's own cards handle 100%
of their own visual chrome — but that's a call for whoever owns this next, not something to
improvise here.

**Confirm this visually in the human QA pass** (added to the new QA script's "known limitations"
section, and as its own checklist item, since it's exactly the kind of thing a screenshot-diff-style
human check would catch immediately and an agent can't verify without a browser).

---

## 4. Join-by-code confirmation (plan's step 7)

Re-ran Task 5's own Definition-of-Done grep, after all subsequent tasks:

```
grep -rn "Room code\|room code\|JoinStudyRoom\|Join Study Room" \
  snufflestudy/src/sidepanel/components/StudyRoomsBox.tsx
```

**Zero matches** (exit code 1) — still clean. Also independently confirmed:
- `grep -n "STUDY_ROOM_INVITEE_ADD" .../StudyRoomsBox.tsx` → only this file's own explanatory
  comment (not a live call) — no add-a-friend-to-room path lives in this component.
- `grep -n "STUDY_ROOM_INVITEE_ADD\|FRIENDS_LIST" .../StudyRoomAccessPopup.tsx` → only its own
  explanatory comment, confirming Decision 3 (remove-only, no add-toggle) still holds after Tasks
  6–13.
- Exactly one `newRoomName`/`handleCreateRoom` pair exists in `StudyRoomsBox.tsx` — one
  create-room path, no second "join by code" input in any form.

---

## 5. New-design coverage for undesigned surfaces (plan's step 8)

Read both files directly (not just trusted the task reports):

**`RequestUnlockForm.tsx`** — confirmed entirely composed from `ButtonLarge` (suggestion chips,
"Request unlock", "Refresh"), `TextInput` (hostname field, wrapped in a real
`<label htmlFor="unlock-request-hostname">`), and `TextSmall` (per-request status rows). The two
`<ul>/<li>` lists are real list semantics styled via `RequestUnlockForm.module.css` (its own new,
co-located file, not a `styles/frontend-backup/` import — correctly, since nothing was ported for
this component). Zero raw `<button>`/`<input>` anywhere; errors surface via `role="alert"`.
Matches the Task 7 report's claim exactly.

**`AccountPage.tsx`'s delete-confirmation dialog** — confirmed built from two `ButtonLarge`s ("Yes,
permanently delete my account" / "Cancel") inside a `role="alertdialog" aria-label="Confirm account
deletion"` div styled via the new, co-located `AccountPage.module.css` (`.deleteConfirmDialog`
etc.) — not the ported `AccountSettingsPanel.module.css`, since (correctly) nothing in
frontend-backup corresponds to this dialog. The destructive action gets `buttonFontWeight="700"`
and a `buttonLargeBackgroundColor="var(--color-pink-100)"` override; "Cancel" stays at default
weight/background, visually subordinate. Zero raw `<button>`/`<input>`/`<ul>` anywhere in this
file. Matches the Task 12 report's claim exactly.

---

## 6. Full tab tour trace (plan's step 1)

Read `SidePanelApp.tsx` and `TabBar.tsx` directly (not a browser click-through — this section is
what an agent *can* verify, the rest is in the QA script).

**`SidePanelApp.tsx`**: `Header`/`TabBar` are both rendered exactly once per render branch, as
siblings *above* the `role="tabpanel"` div whose contents switch on `activeTab` — they are never
inside the `activeTab === "..." && <Tab/>` conditionals, so switching tabs only swaps the tab
content underneath, never remounts Header/TabBar. Confirmed across all relevant branches: the
no-session branch (both mounted, all four tabs reachable), the active-session branch (`Header`
alone — by design, "No TabBar exists during an active session," per the file's own comment; not a
bug), and the COMPLETED/ABANDONED branches (neither mounted directly, but `AppFooter` still is —
consistent with Decision 5's "persistent footer" framing). `onSignInClick` routes to
`setActiveTab("settings")` in both places `Header` is mounted with that prop wired.

**`TabBar.tsx`**: one `TABS.map(...)` loop drives all four tabs uniformly — `aria-selected={id ===
active}` and `ButtonTab`'s `property1={id === active ? "selected" : "default"}` both derive from
the same `active === id` comparison for every tab, so there's no per-tab special-casing that could
drift out of sync. `role="tablist"`/`role="tab"`/`aria-controls="sp-tabpanel"` are preserved on the
real `<button>` wrapping each `ButtonTab`, matching `SidePanelApp.tsx`'s
`role="tabpanel" aria-labelledby={\`sp-tab-${activeTab}\`}` on the other end.

**Conclusion: confirmed exactly as every relevant task report claimed.** No discrepancy found.

---

## 7. Consolidated open-items list

Every item explicitly flagged across Tasks 1–13's own reports, plus this task's two findings
(§2–3 above). Full detail, framed for a QA runner, lives in the new
`docs/qa/V4.2_Two_Account_QA_Script.md`'s "Known, flagged limitations" section — this is the same
list, for the record here:

1. **Nudge Vault's "Edit" icon on written nudges is present but not wired** (Task 10) — no
   `NUDGE_VAULT_TEXT_UPDATE` message exists anywhere in the codebase; clicking it does nothing.
   This is the one item the plan's own Whole-version Definition of Done names explicitly as staying
   flagged rather than resolved.
2. **`sp-app-footer` still carries old-vocabulary visual CSS** (this task, §3 above) — flagged, not
   fixed; likely a visible tan-bordered/cream-background bar wrapping the new-design footer cards.
   Confirm visually.
3. **Nunito webfont is not self-hosted anywhere** (Task 1, confirmed still true — see below) —
   `--font-nunito` falls back to `Arial, sans-serif` wherever it's used (Task 9's
   `FriendDetailsPopup`, Task 11's `TrackingSettings`/`NotificationSettings`/`SettingsBody`/
   `RestrictedSitesList`, Task 13's `HistoryPage`'s expanded event list) — a real, visible
   font-family deviation from frontend-backup's design. `frontend-backup` itself never bundled a
   real Nunito font file (only a remote Google Fonts `@import`, correctly not carried forward per
   Task 1's own reasoning), so there's no local asset to copy — acquiring one wasn't attempted here.
4. **Header's close icon (`icon-close.svg`) is permanently non-interactive** (Task 2) — deliberate,
   not a bug: nothing in the current app has an equivalent action for it, and the plan explicitly
   says not to invent one.
5. **"Join study room" button's visible text intentionally does not match
   `frontend-backup`'s literal copy** ("Join Study Room") (Task 5) — deliberate, to avoid colliding
   with the DoD grep that guards against the deleted join-by-code feature resurfacing. Don't "fix"
   this back to the design's literal capitalization.
6. **"Open a tab to grant access" (the mid-session media-permission-error button in
   `StudyRoomFooter.tsx`) remains a bare, unstyled `<button>`** (Task 6) — pre-existing, pre-v4.2,
   no `frontend-backup` frame exists for this error state; not rebuilt from the design system.
7. **`FriendOptionsPopup`'s "Remove Friend" button is nested one DOM level deeper than
   `frontend-backup`'s own layout** (Task 9) — cosmetic, compensated with `margin-top`; a byproduct
   of reusing the shared `FriendSettingsFields` component (Decision 2) rather than re-deriving its
   markup by hand.
8. **`SettingsPage.tsx`'s "Grant Camera & Microphone Access" button creates a redundant (but
   harmless) second camera/mic affordance when viewed via the full Options tab** (Task 11,
   Decision 7 side effect) — `OptionsApp.tsx`'s own, separate, real camera/mic section (with the
   actual `getUserMedia` flow) already exists right next to it; both work, neither breaks the
   other, but it reads oddly having two "camera & microphone" callouts stacked.
9. **`NotificationSettings`'s trailing quiet-hours checkmark icon is non-interactive** (Task 11) —
   deliberate: quiet-hours fields save on every `onChange`, there's no separate "confirm" step for
   this icon to back.
10. **History box's date-range filter renders as plain `YYYY-MM-DD` text fields, not a native
    calendar-picker widget** (Task 13, Decision 8) — deliberate (`enableAccessibleFieldDOMStructure=
    {false}`, custom `format`), verified only in jsdom; needs a real-browser look.
11. **Task Vault's optional `onClose`/"Back" button remains unstyled** (Task 4) — dead code path,
    no current caller passes `onClose`, no design equivalent; harmless.
12. **Task 4's Goal-select "default" is a one-time fill-when-empty, not a continuous
    re-derivation** — pre-existing v4.1 behavior, unchanged by this plan; noted so nobody mistakes
    it for a v4.2 regression during QA.

Re-confirmed **#3 (Nunito)** independently this task (not just re-quoting Task 1): grepped
`src/styles/` for any `@font-face`/local font file — none exists; grepped `frontend-backup/` for
any bundled font asset — none exists there either (it only ever used a remote `@import`). This
item is still fully open, exactly as Task 1 left it.

---

## What was NOT attempted (by design)

Per the task brief, no browser interaction, no "Load unpacked," no two-account testing was
attempted. Plan steps 2, 3, 4 (Study Room end-to-end, Nudge Vault round trip, Settings exercise
including the real Chrome permission prompt) are handed off in full in
`docs/qa/V4.2_Two_Account_QA_Script.md`.

---

## Files touched by this task

- `snufflestudy/src/sidepanel/styles/frontend-backup/components/study/ActiveSession.module.css` —
  normalized the one remaining unnormalized `bullet-dot.svg` path (§2).
- `snufflestudy/public/bullet-dot.svg` — deleted (now-unreferenced root-level duplicate).
- `docs/reports/v4.2/task-14-report.md` — this report.
- `docs/qa/V4.2_Two_Account_QA_Script.md` — new human QA handoff (Part 2).

## Final verification after all changes

- `npm run compile` — clean.
- `npm run build` — succeeds; `.output/chrome-mv3/sidepanel/assets/bullet-dot.svg` resolves, no
  stray `.output/chrome-mv3/bullet-dot.svg` remains.
- `npx vitest run` — **92 files / 929 tests, all passing.**
