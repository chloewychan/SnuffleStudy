# V3.3 Task 2 report: 8-digit OTP copy fix

**Branch:** `v3.3` (already checked out, per the calling instructions — did not create or switch branches). Confirmed with `git branch --show-current` (`v3.3`) and `git log --oneline` (top: `c472385 feat(v3.3-task1): move Temp Passcode + Unlock Request panels into Friends tab`) before starting.

## Pre-flight verification against the live repo

Grepped the whole repo (not just `SignInForm.tsx`) for `6-digit` before changing anything, per the task instructions:

```
snufflestudy/src/options/pages/AccountPage.test.tsx:24   (test assertion on the display string)
snufflestudy/src/shared/ui/SignInForm.tsx:140             (the actual display string)
snufflestudy/src/infrastructure/backend/supabaseClient.ts:72   (comment re: Supabase Auth's OTP mechanism)
snufflestudy/src/shared/messages.ts:40                    (comment re: signInWithOtp's email contents)
snufflestudy/src/shared/ui/SignInForm.test.tsx:80         (test assertion on the display string)
supabase/functions/approve-temp-passcode/index.ts:104     (comment — unrelated feature: temp-passcode code, not sign-in OTP)
docs/**  (plan/scope/feedback/QA-script/report prose — historical or planning documents)
```

Confirmed only one production display string exists — `snufflestudy/src/shared/ui/SignInForm.tsx:140`, `<p>Check {email} for a 6-digit code.</p>` — matching the plan's claim exactly. No second copy of this display string exists anywhere else in production code. The plan's prose was accurate here; no deviation needed.

## What I built

- **`SignInForm.tsx`:** changed line 140 from `Check {email} for a 6-digit code.` to `Check {email} for an 8-digit code.` — the only production-code change, exactly as Task 2's Deliverables specify ("no other change").
- **`AccountPage.test.tsx`** and **`SignInForm.test.tsx`**: updated the one regex assertion in each (`/check a@example.com for a 6-digit code/i` → `/check a@example.com for an 8-digit code/i`) so they assert against the new copy instead of the old. Not itself a Task 2 deliverable, but a necessary consequence of the string change — both tests directly assert on this exact string, and would otherwise fail `npm run test`.

## Judgment call: what NOT to touch, and why

The repo-wide grep turned up several other "6-digit" occurrences beyond the display string. I left all of them alone:

- **`supabaseClient.ts:72`** and **`messages.ts:40`** — code comments describing Supabase Auth's actual OTP mechanism (`signInWithOtp`/`verifyOtp`), not the UI copy. `docs/scope_summaries/V3.3_Feature_Feedback.md` (section 3.1) is explicit that the *real* OTP length is a Supabase dashboard setting this repo has no record of, and that confirming it is a separate concern from the copy fix ("fixing only the string without confirming the dashboard value would just move the mismatch instead of closing it" — flagged there as a pre-ship verification step, not as part of Task 2's Deliverables, which name only the one quoted string). Rewriting these comments' factual claim without access to the actual dashboard setting would be a guess, not a verified fix, so I left them as-is.
- **`approve-temp-passcode/index.ts:104`** — a comment about the *temp-passcode* approval code (a completely different feature, Task 10's territory), not sign-in OTP. Out of scope for this task on its face.
- **`docs/implementation_plans/V3.1_Implementation_Plan.md`, `docs/qa/V3.2_Two_Account_QA_Script.md`, `docs/reports/v3.2/*.md`, `docs/scope_summaries/V3.3_Scope_Summary.md`, `docs/scope_summaries/V3.3_Feature_Feedback.md`, and this same `V3.3_Implementation_Plan.md`** — historical records and the plan being executed. None of these are the "string" Task 2's Definition of Done refers to; editing them would rewrite history or the plan itself, not implement the fix.

## What I verified

- Repo-wide grep for `6-digit` (excluding `node_modules`/`.git`) before and after the change — confirmed exactly one production display-string hit before (`SignInForm.tsx:140`) and zero after; the two test-file hits were updated to `8-digit` alongside it; every remaining hit after the change is one of the out-of-scope categories above.
- Repo-wide grep for `8-digit` under `snufflestudy/` — three hits, all expected: the fixed string itself and its two updated test assertions.
- `npm run test` (from `snufflestudy/`) → **86 files, 838 tests, all passed.**
- `npm run compile` (`tsc --noEmit`, from `snufflestudy/`) → clean, no type errors.
- `git diff --stat` confirms only three files touched: `SignInForm.tsx`, `AccountPage.test.tsx`, `SignInForm.test.tsx` — no files belonging to other numbered tasks were modified. `docs/Multi_Step_Plan_Execution_Workflow.md` still shows as locally modified (pre-existing, unrelated in-flight work per the plan's own "Repository state, checked directly" section) and is not part of this commit.

## What's still open

Nothing within Task 2's own scope. One item flagged in `docs/scope_summaries/V3.3_Feature_Feedback.md` but explicitly outside this task's Deliverables: confirming in the Supabase dashboard that the project's actual email-OTP length is set to 8 (not just that the copy now claims 8). That's an external, non-repo verification step this plan's Task 2 doesn't ask for and this task doesn't have dashboard access to perform — noted here so it isn't lost, not treated as a blocker for this task's own Definition of Done, which is scoped to the copy alone. Task 14 restructures `SignInForm.tsx` significantly later, per the plan — not anticipated here, as instructed.
