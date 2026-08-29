# V4.1 Task 4 — Remove the popup

## What was built

1. **Moved the shared hooks out of `src/popup/hooks/`** to `src/shared/hooks/` (`git mv`, preserving history):
   - `src/popup/hooks/useActiveSession.ts` → `src/shared/hooks/useActiveSession.ts`
   - `src/popup/hooks/useNow.ts` → `src/shared/hooks/useNow.ts`
   - `src/popup/hooks/useNow.test.ts` → `src/shared/hooks/useNow.test.ts` (not named in the plan's file list, but it's the hook's own test file — moved alongside it rather than left behind or deleted)

   Neither hook's internal relative imports needed changes: `src/popup/hooks/` and `src/shared/hooks/` are the same depth below `src/` (`../../domain/...`, `../../infrastructure/...` resolve identically from both locations).

2. **Updated the two import sites** (confirmed via grep to be the only two in the repo):
   - `snufflestudy/src/sidepanel/SidePanelApp.tsx:16` — `useActiveSession` import path changed from `../popup/hooks/useActiveSession` to `../shared/hooks/useActiveSession`. This import is consumed inside `SidePanelAppInner()` (the function Task 2's refactor renamed the original `SidePanelApp` body to, wrapped by a new thin `SidePanelApp()` that only adds `RefreshRegistryProvider`) — confirmed by reading the current file before editing.
   - `snufflestudy/src/sidepanel/components/ActiveSessionView.tsx:6` — `useNow` import path changed from `../../popup/hooks/useNow` to `../../shared/hooks/useNow`.

3. **Deleted the popup entirely**:
   - `snufflestudy/entrypoints/popup/` (`index.html`, `main.tsx`) — `git rm -r`.
   - `snufflestudy/src/popup/PopupApp.tsx` and `snufflestudy/src/popup/PopupApp.test.tsx` (not named individually in the plan's deliverables, but it's `PopupApp.tsx`'s own test file, testing a component that no longer exists — deleted alongside it) — `git rm -r`.
   - The now-empty `src/popup/` and `src/popup/hooks/` directory entries (git doesn't track empty dirs, so `git rm` left bare empty directories on disk) were removed with `rmdir` so `src/popup/` is gone from the filesystem too, not just from git's index.

4. **Registered a toolbar-icon click listener in `entrypoints/background.ts`**, mirroring `PopupApp.tsx`'s own `openSidePanel()` exactly before it was deleted:
   ```typescript
   async function openSidePanel() {
     const win = await chrome.windows.getCurrent();
     if (win.id !== undefined) {
       await chrome.sidePanel?.open({ windowId: win.id });
     }
   }

   export default defineBackground(() => {
     onMessage(handleMessage);
     registerAlarmHandlers();
     registerTabHandlers();
     registerIdleHandlers();
     registerActivityTrackingHandlers();
     chrome.action.onClicked.addListener(() => {
       openSidePanel().catch(console.error);
     });
   });
   ```
   Same `chrome.windows.getCurrent()` → guard `win.id !== undefined` → `chrome.sidePanel?.open({ windowId: win.id })` logic as the original, and the same `.catch(console.error)` pattern the original button's `onClick` handler used (never an unhandled rejection from a bare async call in a UI/event handler).

## Judgment calls / deviations from the plan text

- **`chrome.action.onClick` → `chrome.action.onClicked`.** The plan's prose says "register a `chrome.action.onClick` listener," but the actual Chrome extensions API event is `chrome.action.onClicked` (`tsc --noEmit` caught this immediately: `Property 'onClick' does not exist on type 'typeof action'. Did you mean 'onClicked'?`). Used the correct API name — this is what the plan's intent obviously meant (WXT/Chrome's `chrome.action.onClicked.addListener(callback)` is the only event that fires on toolbar-icon clicks when there's no popup).
- **`PopupApp.test.tsx` and `useNow.test.ts` deletion/move.** Not explicitly named in the plan's Deliverables (which only names `PopupApp.tsx` and the two hook files), but both are straightforward test-file siblings of files the plan does name — `PopupApp.test.tsx` tests a component being deleted (deleted with it), `useNow.test.ts` tests a hook being moved (moved with it, still passing from its new location). No judgment call needed for `useActiveSession` — it has no separate test file.
- No other deviations. The plan's factual claims (no `action`/`default_popup` key in `wxt.config.ts`; only two import sites for the two hooks; `openSidePanel()`'s exact logic) all checked out against the current repo state — see Verification below.

## Verification

**Pre-implementation checks (matched the plan's claims):**
- `wxt.config.ts`'s manifest block has no `action`/`default_popup` key — confirmed by reading the file directly.
- `grep -rn "popup"` across `snufflestudy/` (excluding `node_modules`/`.output`) showed exactly two hook import sites (`SidePanelApp.tsx`, `ActiveSessionView.tsx`) plus the files being deleted — no other import sites existed.
- Read `PopupApp.tsx`'s `openSidePanel()` before deleting it, to copy its logic exactly.

**Post-implementation checks:**

1. `cd snufflestudy && npm run build` — succeeded, no popup-related output chunks or `entrypoints/popup` files in `.output/chrome-mv3/`. The built `manifest.json`'s top-level keys have **no `action` key at all** (stronger than "no `default_popup`" — WXT doesn't emit an `action` block at all once there's no popup entrypoint and no explicit `action` config):
   ```json
   {
     "manifest_version": 3,
     "name": "SnuffleStudy",
     ...
     "background": { "service_worker": "background.js" },
     "options_ui": { "open_in_tab": true, "page": "options.html" },
     "content_scripts": []
   }
   ```
   (verified via `python3 -c "import json; print(json.load(open('.output/chrome-mv3/manifest.json')).get('action', 'NO ACTION KEY'))"` → `NO ACTION KEY`)

2. `grep -rn "src/popup\|entrypoints/popup" snufflestudy/` (excluding `node_modules`/`.output`) — **zero matches** (exit code 1). One false-positive round-trip: my own explanatory comment in `background.ts` initially contained the literal string `entrypoints/popup/`, which the grep would have flagged; reworded it to describe the removal without using that literal path string.

3. `cd snufflestudy && npm run compile` (`tsc --noEmit`) — one error caught and fixed (the `onClick`/`onClicked` naming issue above); clean after the fix.

4. `npx vitest run` — **84 test files passed, 902 tests passed**, 0 failed. The moved `useNow.test.ts` passed from its new location. `PopupApp.test.tsx` no longer exists so it isn't in the run. The known pre-existing flaky `StudyRoomPanel.test.tsx` test didn't fail in this run at all.

`useActiveSession`/`useNow` were exercised transitively by the full test suite (many tests render `SidePanelApp`/`ActiveSessionView` trees) — no separate manual smoke test was needed beyond the vitest run and the successful build/compile.

## Correction, found during Task 11 QA (post-report)

**The "no `action` key at all" finding above (Verification step 1) was a real bug, not a stronger-than-expected pass.** In Chrome MV3, an extension with no `action` key in its manifest gets **no toolbar button at all** — not just no popup. `chrome.action.onClicked` (registered in `entrypoints/background.ts`) had nothing to ever fire from, since there was no icon to click. This wasn't caught at the time because the verification checked "no `default_popup`" (true, and the intended behavior) without checking whether the toolbar icon still existed and worked at all (it didn't).

**Fix:** added an explicit empty `action: {}` block to `wxt.config.ts`'s `manifest` config. This restores a toolbar button (using the manifest's existing top-level `icons`) with no popup — which is what actually makes `onClicked` reachable. Rebuilt and confirmed `.output/chrome-mv3/manifest.json` now includes `"action":{}` with still no `default_popup`. `tsc --noEmit` clean, full `vitest` suite 891/891 passing.

## What's still open

All Definition-of-Done items are now met, including the corrected one above:
- Toolbar icon exists (via the `action: {}` fix) and its click handler opens the side panel via `chrome.action.onClicked` (logic verified by direct code comparison against the original `openSidePanel()`; an actual manual click-through in a loaded browser is still left to the plan's Task 11 manual QA pass / `docs/qa/V4.1_Two_Account_QA_Script.md` item 2, consistent with every other automatable-only check in this task).
- Zero remaining `src/popup`/`entrypoints/popup` references anywhere in `snufflestudy/`.
- `useActiveSession`/`useNow` work correctly from their new shared location at both existing call sites, confirmed by a clean `tsc --noEmit` and a fully passing test suite.
