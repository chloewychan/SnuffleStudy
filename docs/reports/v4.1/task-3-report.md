# Task 3 — Onboarding trim, baked-in defaults, and default task seed

## What was built

- `snufflestudy/src/app/routes/OnboardingWizard.tsx` — rewritten. `showWelcome` still gates the
  Welcome screen first; after it, only the sign-in step renders (heading "Sign in", `SignInForm`
  with the unchanged framing copy). All local state and render branches for the removed
  `"name"`/`"pressure"`/`"duration"`/`"tracking"`/`"sites"`/`"passcode"`/`"review"` steps are gone,
  along with their now-unused imports (`PRESSURE_PROFILES`, `TrackingTier`,
  `requestDetailedTrackingPermission`, `registerOverlayContentScript`).
  `SignInForm`'s `onSignedIn` and `onSkip` both now call `finishOnboarding()` directly.
  `finishOnboarding()` calls `SETTINGS_SAVE` with the fixed payload specified in the plan
  (`pressureProfileId: "gentle-encouragement"`, `trackingTier: "activity-only"`,
  `activityTrackingEnabled: true`, `defaultFocusDurationSeconds: 1500`,
  `defaultBreakDurationSeconds: 300`, `defaultAllowedSites: []`, `defaultRestrictedSites: []`,
  `defaultRestrictionMode: "soft"`, `onboardingCompleted: true`, plus `friendSyncEnabled: false` /
  `liveNudgesNotificationsEnabled: true` / `digestNotificationsEnabled: true` / `quietHours: null`
  carried over unchanged from what the old `finish()` always sent regardless of user input — these
  four were never collected by any onboarding step even before this trim). On success it then
  calls `sendMessage({ type: "TASK_CREATE", payload: { title: "Study with Snuffles" } })`,
  wrapped in its own try/catch that only `console.error`s on failure (does not set `finishError`,
  does not block `onComplete()`), then calls `onComplete()`. A `SETTINGS_SAVE` failure is still
  surfaced via the existing `finishError`/`role="alert"` pattern and does not call `onComplete()`.
- `snufflestudy/src/domain/settings/userSettings.ts` — `DEFAULT_USER_SETTINGS.pressureProfileId`
  changed from `"strict-coach"` to `"gentle-encouragement"`.
- `snufflestudy/src/app/routes/OnboardingWizard.test.tsx` — rewritten. Deleted every test case
  that exercised the removed steps (`"walks through all steps…"`, the detailed-tracking/site-list
  tests, the overlay-content-script registration tests, the entire `"optional passcode step"`
  describe block) rather than leaving them failing. Kept and updated the sign-in-step tests (they
  now assert `onComplete()` fires and `SETTINGS_SAVE`/no `AUTH_*` calls, instead of asserting a
  transition to the now-deleted `"name"` step). Added three new tests:
  - `"finishes onboarding with fixed defaults after 'Skip for now'"` — asserts the exact
    `SETTINGS_SAVE` payload.
  - `"finishing onboarding creates the default 'Study with Snuffles' task"` — asserts `TASK_CREATE`
    fires with the right payload, after `SETTINGS_SAVE`, and `onComplete()` still fires. This is
    the plan's required "finishing onboarding creates the default task" test.
  - `"still completes onboarding if seeding the default task fails"` — asserts `TASK_CREATE`
    rejecting doesn't block `onComplete()` and is logged via `console.error`.
  Also updated the top-of-file `skipAccountStep()`/removed `skipPasscodeStep()` helpers and their
  comments to reflect the new one-step flow.

## Deviations / judgment calls

1. **Removed the `Step` type/state entirely rather than keeping a single-value union.** The plan's
   Interfaces section says the `Step` union "shrinks to `"account" | "review"`", but its own next
   sentence says the `"review"` step's copy is also removed and `finish()` is called directly from
   the account step's handlers "instead of routing through an intermediate step" — i.e. no code
   path ever sets `step` to anything but its initial value. The Deliverables section confirms this:
   "after it, only the `"account"` step remains... whose... handlers both now call a single
   `finishOnboarding()` directly." A one-value union with no setter calls left is dead state, so I
   deleted `Step`/`step`/`setStep` outright and render the sign-in step unconditionally once
   `showWelcome` is false. Functionally identical to keeping a vestigial `Step` type; simpler code.
2. **Renamed `finish()` to `finishOnboarding()`** per the Deliverables section's naming
   (`finishOnboarding()` calls `SETTINGS_SAVE`...), rather than keeping the old `finish` name.
3. **Left `WelcomeScreen.tsx` untouched**, including its now slightly stale copy ("The next few
   steps set up your study companion, your accountability style, and — if you're ready — a
   hard-block passcode") — explicitly out of scope per the plan ("Don't modify `WelcomeScreen.tsx`
   ... both are kept as-is per the plan's Scope").
4. **Left a stale comment in `SidePanelApp.test.tsx`** (`"...before its 'name' step ('Meet
   Snuffles')."`) untouched — it's a comment only (no assertion depends on the removed step), and
   that file isn't part of this task's Deliverables.
5. Kept the `TASK_CREATE` seed call as a nested try/catch inside the outer `finishOnboarding` body
   (rather than a separate helper) to match the plan's one-paragraph description exactly: logged
   via `console.error`, never sets `finishError`, never blocks `onComplete()`.

## Verification

- Read the actual pre-change `OnboardingWizard.tsx`, `OnboardingWizard.test.tsx`, and
  `domain/settings/userSettings.ts` before editing (not just the plan's description) — confirmed
  the plan's description of current state matched reality (seven-step wizard, `DEFAULT_USER_
  SETTINGS.pressureProfileId: "strict-coach"`, `PRESSURE_PROFILES[0]` was already
  `"gentle-encouragement"` as a valid profile id in `domain/pressure/pressureProfiles.ts`).
- `cd snufflestudy && npx vitest run src/app/routes/OnboardingWizard.test.tsx
  src/domain/settings/userSettings.test.ts` — 2 files, 18 tests, all pass.
- Broader regression check: ran every test file that references `DEFAULT_USER_SETTINGS` (`friendSync.test.ts`,
  `messageRouterFriendSync.test.ts`, `alarmHandlers.test.ts`, `OptionsApp.test.tsx`,
  `SidePanelApp.test.tsx`, `SessionSetupForm.test.tsx`, `StudyTab.test.tsx`,
  `SettingsTab.test.tsx`, `chromeStorageRepository.test.ts`) — 9 files, 156 tests, all pass; the
  `pressureProfileId` default change didn't break anything depending on it.
- Full repo test run (`npx vitest run`): 897 passed / 4 failed across 84 files. The 4 failures are
  all in `nudgeApi.test.ts` and `messageRouterAccountability.test.ts`, entirely unrelated to this
  task's files — they come from another task's (Task 1, Nudge Vault) in-progress, uncommitted work
  already present on this shared `v4.1` branch (`NudgeSource`/`customBody` changes to
  `nudgeApi.ts`/`FriendNudge`). Verified this independently: stashed just my three changed files
  and re-ran `npm run compile`, and the exact same pre-existing errors appeared with my changes
  absent, confirming they predate and are unaffected by this task's work. Multiple other tasks
  (2, 5, and pieces of 7/1) are visibly mid-flight, uncommitted, on this same branch — `git status`
  showed `nudgeApi.ts`, `producerTagApi.ts`, `messages.ts`, `SidePanelApp.tsx`, `Header.tsx`,
  `BunnyTab.tsx`, `sidepanel/refresh/`, and a new migration file all modified/untracked, none of
  which this task touched.
- `cd snufflestudy && npm run compile` (`tsc --noEmit`): the only errors present are the same
  pre-existing ones listed above (all in files this task didn't touch: `alarmHandlers.ts`/`.test.ts`,
  `messageRouter.ts`, `messageRouterAccountability.test.ts`, `nudgeApi.test.ts`,
  `FriendGroupPanel.test.tsx`, `IncomingNudgeCard.tsx`). Zero errors in `OnboardingWizard.tsx`,
  `OnboardingWizard.test.tsx`, or `userSettings.ts`.

## Definition of Done — checked against the plan's text

- Fresh install → Welcome → sign-in step → "Skip for now" or completed sign-in → `onComplete()`
  fires directly (no further onboarding screens): covered by the new tests.
- `SETTINGS_SAVE` payload shows `pressureProfileId: "gentle-encouragement"`,
  `defaultFocusDurationSeconds: 1500`, `trackingTier: "activity-only"`,
  `defaultRestrictionMode: "soft"`: asserted exactly in
  `"finishes onboarding with fixed defaults after 'Skip for now'"`.
- `TASK_CREATE` fires with `{ title: "Study with Snuffles" }`: asserted in
  `"finishing onboarding creates the default 'Study with Snuffles' task"`.
- Existing test cases for removed steps deleted, not left failing: confirmed — the file's step
  count went from 8 render branches/12 tests to 2 branches/12 tests (3 new, `~9` remapped/kept from
  the original 12 top-level `it`s plus the `describe` blocks), zero references to `"name"`,
  `"pressure"`, `"duration"`, `"tracking"`, `"sites"`, `"passcode"`, or `"review"` steps remain.
- Sign-in-step test and the new default-task test both pass: confirmed via the vitest run above.

## Open items

None for this task. The 4 pre-existing failing tests and the pre-existing `tsc` errors belong to
Task 1's in-progress work on this shared branch and are outside Task 3's scope — flagging here so
the orchestrator doesn't mistake them for something this task introduced or should have fixed.
