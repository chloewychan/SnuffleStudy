# V3.4 Task 7 report: Consolidate account creation onto one screen

**Branch:** `v3.4` (already checked out — confirmed with `git branch --show-current` → `v3.4`, and `git log --oneline -8`, top: `78359c8 feat(v3.4-task6): require the current password before changing it`).

## Pre-flight verification against the live repo

Read Task 7's full block (`docs/implementation_plans/V3.4_Implementation_Plan.md`, lines 1806–1992) and `V3.4_Scope_Summary.md` Section 1 item 3. Read `shared/ui/SignInForm.tsx` in full before editing and independently confirmed every claim the plan makes about current state:

- `Mode` union currently has `"create-email"` → `"create-code"` → `"create-password"`, exactly as claimed.
- `pendingCreateSession` exists, used only to bridge `AUTH_VERIFY_OTP`'s session to the old manual `handleSetPassword` submit.
- `handleCreateVerifyOtp`'s current shape (verify → hold session → `setMode("create-password")`) matched.
- `AUTH_SET_PASSWORD`'s contract in `shared/messages.ts` already carries `currentPassword?: string` (Task 6, landed) — confirmed the type line directly (`shared/messages.ts:64`) and confirmed `messageRouter.ts`'s handler (lines 499–529) genuinely no-ops the current-password check when `profileApi.getMyProfile()` returns a profile with a falsy `passwordSetAt` — i.e. Task 6's Depends-on contract really is live and a brand-new account's `completeAccountCreation` call needs no `currentPassword`.
- `PROFILE_SAVE_MINE`'s payload shape confirmed as `{ humanName?: string; bunnyName?: string }` (`shared/messages.ts:275`).
- `OnboardingWizard.tsx` confirmed to just render `<SignInForm framingCopy=... onSignedIn=... onSkip=... />` with no internal awareness of its modes — the plan's claim that this task requires no edit there held up.
- Grepped the whole `src/` tree for `create-email`/`create-password`/`pendingCreateSession` — only `SignInForm.tsx` itself referenced them, confirming the "In: SignInForm.tsx's create-account branch only" scope boundary was accurate and complete.

## What I built

Edited only `snufflestudy/src/shared/ui/SignInForm.tsx`, per spec:

- `Mode` union: `"create-email"` → `"create-details"`; `"create-password"` removed entirely. Updated the branch-structure comment above it.
- New state: `humanName`, `bunnyName`, alongside the existing `password`/`confirmPassword`. `pendingCreateSession` replaced by `verifiedSession` (same slot, different purpose — documented in place per the plan's own comment: exists purely to make automatic completion retryable, not to gate a manual next step).
- New `"create-details"` step JSX: Name (required)/Bunny name (optional, no `required`, no non-empty check)/Email (required)/Password (required)/Confirm password (required); submit disabled until `!authBusy && humanName && email && password && password === confirmPassword`.
- New `completeAccountCreation(session)`: `AUTH_SET_PASSWORD` (no `currentPassword`) → `PROFILE_SAVE_MINE({ humanName, bunnyName: bunnyName || undefined })`; either failure sets an inline error and returns without clearing form state or calling `onSignedIn`; full success clears `otpCode`/`password`/`confirmPassword`/`verifiedSession` and calls `onSignedIn(session)`.
- Rewrote `handleCreateVerifyOtp`: on `AUTH_VERIFY_OTP` success, sets `verifiedSession` then immediately awaits `completeAccountCreation`; on failure, sets an inline error and does not touch `verifiedSession`.
- `"create-code"` step: added the conditional retry button (`verifiedSession` set → "Retry"/"Finishing…" calling `completeAccountCreation(verifiedSession)` directly, never `AUTH_VERIFY_OTP`; otherwise the existing "Verify code"/"Verifying…" submit). Code input and "Use a different email"/"Request a new code" buttons unchanged except the "Use a different email" target mode (`"create-email"` → `"create-details"`).
- `mode === "choice"`: `setMode("create-email")` → `setMode("create-details")`, the only change to that branch.
- `"create-password"` mode branch (JSX + `handleSetPassword`) removed entirely.

**One bug found and fixed, not in the plan's literal snippet:** the plan's given `handleCreateVerifyOtp` code has no `finally` block and the `!res.ok` early-return branch never calls `setAuthBusy(false)` (only the success path and the `catch` block do). Implemented verbatim first, then caught it immediately via my own new test (`"Verifying…"` stayed permanently disabled after a wrong/expired code — see the failing-test output during development). Fixed directly by adding `setAuthBusy(false)` to that branch, consistent with the standing instruction to fix this class of async-handler state-lifecycle gap without asking. Documented in the code with a comment explaining why this branch needs its own reset (no shared `finally` covers it, since the success path deliberately hands `authBusy` off to `completeAccountCreation`'s own lifecycle).

## What I verified

**`cd snufflestudy && npx vitest run src/shared/ui/SignInForm.test.tsx`** — 19/19 passing after rewriting every assertion that referenced `"create-email"`/`"create-password"` modes or a separate password step:
- Disabled-submit test moved to the `"create-details"` step itself (name/email/password/confirm-password, bunny name never touched — confirms it's genuinely optional).
- New test: a fresh sign-up sends exactly one `AUTH_REQUEST_OTP` from `"create-details"` and advances to `"create-code"`.
- New test: entering the correct code fires `AUTH_VERIFY_OTP` → `AUTH_SET_PASSWORD` → `PROFILE_SAVE_MINE` in that exact order (asserted via a `callOrder` array pushed inside the mock), `onSignedIn` called only once all three succeed, with the exact `PROFILE_SAVE_MINE` payload (`{ humanName: "Robin", bunnyName: undefined }`) and `AUTH_SET_PASSWORD` payload asserted.
- **The required negative case, run exactly as specified:** `"Retry after a failed AUTH_SET_PASSWORD completes the account and sends AUTH_VERIFY_OTP exactly once total across both attempts"` — stubs `AUTH_SET_PASSWORD` to fail on its first call and succeed on its second, verifies the code once, waits for the "Retry" button, clicks it, waits for `onSignedIn`, then filters `sendMessageSpy.mock.calls` for `AUTH_VERIFY_OTP` and asserts `.toHaveLength(1)`. **Result: passed** — `AUTH_VERIFY_OTP` sent exactly once total across both completion attempts, `AUTH_SET_PASSWORD` attempted twice.
- Wrong/expired-code test rewritten to assert no "Retry" button appears (nothing was verified) and "Verify code" remains.
- "Skip for now" test rewritten for the two-step (not three-step) create-account branch: choice → create-details → create-code (before code entry).

**Sign-in branch (`signin-choice`/`signin-password`/`signin-otp-email`/`signin-otp-code`) tests left completely unmodified** — all still pass (verified as part of the same file's 19/19 run and the full-suite run below). No line in that branch's JSX or handlers was touched.

**`cd snufflestudy && npx vitest run` (full suite)** — **84 test files, 899 tests, all passing.** This surfaced two more consumers of `SignInForm`'s create-account internals I hadn't been pointed at explicitly, both fixed:
- `src/app/routes/OnboardingWizard.test.tsx` — one test (`'"Skip for now" still advances past the create-account password step...'`) drove `SignInForm` through the now-removed `"create-email"` → verify → `"create-password"` sequence directly. Rewrote it to the new flow's equivalent risk point: `AUTH_SET_PASSWORD` mocked to fail so a "Retry" button is showing (the new "most at risk of trapping onSkip" moment, since completion is now automatic rather than gated behind a manual step), then confirms "Skip for now" still escapes to the "name" step. Leaving this test unmodified was not achievable — the component's own contract genuinely changed (no more manual password step to skip from); rewriting it was the only way to keep testing the same underlying guarantee (Skip never gets trapped) against real current behavior rather than deleting coverage. `OnboardingWizard.tsx` itself was not touched. Full file: 17/17 passing.
- `src/options/pages/AccountPage.test.tsx`'s "creating a new account" describe block (signed-out `AccountPage` rendering `SignInForm`'s create-account branch at its own call site) also drove the old three-step flow. Rewrote both tests to the new one-screen flow (fill Name/Email/Password/Confirm on `"create-details"`, verify code, assert completion failure/success) — same intent (does not sign in until completion truly succeeds; signs in once it does), same message-mocking pattern, new flow shape. `AccountPage.tsx` itself was not touched — this is signed-out account creation via `SignInForm`, a different surface from `AccountPage.tsx`'s own signed-in "change password" section (Task 6's territory, genuinely untouched — verified via `git diff`, only test files and `SignInForm.tsx` appear in the diff).

**`cd snufflestudy && npm run compile`** — clean, zero errors.

**`git status`/`git diff --stat`** confirms the diff touches exactly four files: `SignInForm.tsx`, `SignInForm.test.tsx`, `OnboardingWizard.test.tsx`, `AccountPage.test.tsx` — no non-test file outside `SignInForm.tsx` was edited, matching the task's "In: SignInForm.tsx's create-account branch only" scope.

**Definition of done, item by item:**
- Fresh sign-up sends exactly one `AUTH_REQUEST_OTP` and advances to `"create-code"` — test-verified.
- `AUTH_VERIFY_OTP` → `AUTH_SET_PASSWORD` → `PROFILE_SAVE_MINE` in that order, `onSignedIn` only once all three succeed — test-verified (call-order assertion).
- Negative case, `AUTH_VERIFY_OTP` sent exactly once across both completion attempts — test-verified, exact scenario from the task spec.
- Sign-in branch completely unaffected, same steps/messages as before — verified: zero edits to that branch's code, and its existing tests (unchanged) still pass.
- Every stale `SignInForm.test.tsx` assertion rewritten — done, 19/19 passing.
- `OnboardingWizard`'s own tests still pass — 17/17, with one test's *internals* necessarily rewritten (see judgment call below) since it drove `SignInForm`'s now-removed steps directly; `OnboardingWizard.tsx` itself untouched.
- `npx vitest run` and `npm run compile` both clean — confirmed.

## Judgment calls

- **Fixed the `authBusy` reset bug in `handleCreateVerifyOtp`'s failure branch**, which the plan's own literal code snippet has (see above). This is a correctness fix, not a deviation from the plan's intent — the plan's prose never says the button should stay stuck disabled after a wrong code, and my own new test coverage would not have passed otherwise.
- **`OnboardingWizard.test.tsx` and `AccountPage.test.tsx` required edits**, despite the task instructions calling out only `SignInForm.test.tsx` for rewriting and stating `OnboardingWizard`'s tests should pass "unmodified." In practice, one test in each file drives `SignInForm`'s create-account branch through its old internal step sequence by name (filling only an email before submit, expecting a `"Password"` label to appear after code verification) — behavior Task 7 deliberately removes. "Unmodified" and "still passing" were mutually exclusive for these two specific tests once the single-screen flow shipped; deleting coverage instead of updating it seemed clearly worse than a minimal, intent-preserving rewrite, so I rewrote them (documented per-file above) rather than stopping to ask, consistent with "routine judgment calls — make the call, document it, keep going." Neither `OnboardingWizard.tsx` nor `AccountPage.tsx` (the components) were touched — only their test files.
- **No live Supabase verification** — per the task's own framing, this is a pure client-side state-machine rewrite in one file, and the existing test suite already mocks `sendMessage` for this component; there is no new backend surface for Task 7 to verify live (Task 6 already live-verified `AUTH_SET_PASSWORD`'s contract).

## What's still open

Nothing outstanding within Task 7's scope. All Definition of Done items are test-verified above, `npx vitest run`/`npm run compile` are both clean, and the diff is confined to `SignInForm.tsx` plus the three test files whose coverage of its create-account branch needed rewriting to match the new one-screen flow.
