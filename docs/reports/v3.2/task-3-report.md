# V3.2 Task 3 report: Automated test coverage for the onboarding auth step

**Branch:** `v3.2` (off `main`, per the plan's branching strategy). Confirmed with `git branch --show-current` (`v3.2`) and `git log --oneline -5` (top: `3f95e94` Task 2, `25b81d7` Task 1, `c120784` Task 0) before starting; did not create a new branch.

## Pre-flight verification against the live repo

Per the workflow doc, I read the actual current files rather than trusting the plan's Task 3 prose (which predates Task 1's refactor):

- Read `docs/reports/v3.2/task-1-report.md` and `docs/reports/v3.2/task-2-report.md` in full first, to pick up the documented deviation and Task 2's (unrelated) findings before touching anything.
- Read `snufflestudy/src/app/routes/OnboardingWizard.tsx` directly: the `step === "account"` branch renders `<SignInForm framingCopy="Sign in to use friends, rooms, nudges, approvals, and synced accountability features." onSignedIn={() => setStep("name")} onSkip={() => setStep("name")} />` inside a `<div className="onboarding-step"><h2>Sign in</h2>...` wrapper. Confirmed the exact framing-copy string here rather than trusting the plan's Task 1 prose, since Task 1 could in principle have altered it (it didn't).
- Read `snufflestudy/src/shared/ui/SignInForm.tsx` directly: confirmed the actual shipped prop shape is `onSignedIn: (session: SignInFormSession) => void` (Task 1's documented deviation from the plan's literal `() => void`), and that `onSkip` fires synchronously with no `sendMessage` call at all — so "Skip for now" is trivially free of any `AUTH_*` call by construction, not just by the current mock setup. Also confirmed `SignInForm` never calls `AUTH_GET_SESSION` itself (unlike `AccountPage.tsx`'s own wrapper) — so none of the onboarding account-step tests need to mock that message type, unlike `AccountPage.test.tsx`.
- Read `snufflestudy/src/app/routes/OnboardingWizard.test.tsx` in full before editing: confirmed the existing `sendMessage` mocking convention is a `vi.spyOn(messenger, "sendMessage")` per test, either `.mockResolvedValue({ ok: true })` for tests that don't care what's sent, or `.mockImplementation(async (message: any) => { if (message.type === "...") return {...}; return { ok: true }; })` for tests that need type-specific responses (used by the existing "surfaces an error and stays on the passcode step..." case). Also confirmed the existing `dismissWelcome()` and `skipAccountStep()` helpers (the latter just clicks the "Skip for now" button — already used by every other step's test as a way past the account step).
- Read `snufflestudy/src/options/pages/AccountPage.test.tsx` in full for the parallel OTP-round-trip convention (`AUTH_REQUEST_OTP` → fill `Email`/click "Send sign-in code" → `Code` field appears → fill/click "Verify code"), since `SignInForm` is now the shared implementation behind both files' tests and the DOM shape (labels, button text) is identical between them.

## What I added

Four new test cases in a new `describe("account (sign-in) step", ...)` block in `OnboardingWizard.test.tsx`, placed after the top-level tests and before the existing `"optional passcode step"` describe block:

1. **"renders the exact framing copy"** — renders, dismisses welcome, asserts the `<h2>Sign in</h2>` heading (`getByRole("heading", { name: "Sign in" })`) and the exact framing-copy string (`getByText` with the full literal string, not a substring match) are both present. No `sendMessage` mock needed — nothing async fires before this assertion.
2. **`'advances to "name" via "Skip for now" without calling any AUTH_* message'`** — mocks `sendMessage` with a blanket `mockResolvedValue({ ok: true })` (so any unexpected call wouldn't crash the test with the mock returning `undefined`), clicks "Skip for now", asserts `"Meet Snuffles"` (the "name" step's heading text) is now on screen, and asserts none of the spy's recorded calls have a `message.type` starting with `"AUTH_"`.
3. **`'advances to "name" after a successful AUTH_REQUEST_OTP -> AUTH_VERIFY_OTP round trip'`** — mocks `sendMessage` to answer `AUTH_REQUEST_OTP` with `{ ok: true }` and `AUTH_VERIFY_OTP` with `{ ok: true, session: { user: { id: "user-a", email: "a@example.com" } } }`; fills the `Email` field, clicks "Send sign-in code", waits for the `Code` field, fills it, clicks "Verify code"; asserts `"Meet Snuffles"` renders and both messages were sent with the exact expected payloads.
4. **"shows the error and stays on the account step when AUTH_VERIFY_OTP fails"** — same round trip, but `AUTH_VERIFY_OTP` resolves `{ ok: false, error: "Token has expired or is invalid" }`; asserts the `role="alert"` element shows that text, `"Meet Snuffles"` is absent, and the `"Sign in"` heading is still present (i.e., still on the account step).

## Judgment calls

1. **Used `sendMessageSpy.mock.calls.some(...)` rather than an asymmetric-matcher `not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^AUTH_/) }))` for case (b).** Both work; I picked the explicit form because it reads unambiguously as "scan every call this test made, confirm none was `AUTH_*`" without relying on nested-asymmetric-matcher behavior, and it's easy to verify by eye that it does exactly what the DoD asks.
2. **Did not add a redundant `AUTH_GET_SESSION` mock to any of the four new tests.** Confirmed by reading `SignInForm.tsx` that it never calls that message type (only `AccountPage.tsx`'s own wrapper does, before rendering `SignInForm`) — adding an unused mock branch would misleadingly imply the onboarding account step checks session state on mount, which it doesn't.
3. **No source changes.** Read `OnboardingWizard.tsx` and `SignInForm.tsx` end to end while verifying test behavior and found no bug blocking any of the four cases — all four passed on the first run with the implementation as Task 1 shipped it. Per the brief, this stayed test-only.

## What I verified

- `npx vitest run OnboardingWizard.test.tsx` → **1 file, 16 tests, all passed** (12 pre-existing + 4 new).
- `npx vitest run` (full suite) → **83 files, 808 tests, all passed** (up from Task 2's 804 — exactly the 4 new cases added here).
- `npm run compile` (`tsc --noEmit`) → clean, no type errors.
- Confirmed `git status` shows only `OnboardingWizard.test.tsx` as a change attributable to this task; `docs/Multi_Step_Plan_Execution_Workflow.md` shows as modified too, but that's the same pre-existing, session-predating uncommitted change Task 2's report already flagged and deliberately left out of its own commit — left out of this commit for the same reason, not touched by this task.

## What's still open

Nothing within Task 3's own scope — all four DoD cases pass. Task 4 (harden onboarding OTP copy: wrong/expired code messaging, "Request a new code" button) is next and will likely add more cases alongside these; nothing here blocks it.
