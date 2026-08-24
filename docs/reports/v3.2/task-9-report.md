# V3.2 Task 9 report: Manual two-account QA and a canonical QA script

**Branch:** `v3.2` (off `main`, per the plan's branching strategy). Confirmed with
`git branch --show-current` (`v3.2`) and `git log --oneline -11` (top: `d6d4e43` Task 8, then
Tasks 7→0, then `ce54d8a` the v3.1 merge and `f03eaa8` pre-v3.2 `main`) before starting; did not
create a new branch.

Per this task's own brief and the plan's Task 9 section: **Task 9 itself ("manual two-account QA")
is a human step.** This session did not sign into anything, did not start a dev server expecting
live interaction, and did not apply any of the three pending migrations or deploy either changed
Edge Function. The deliverable here is the documentation artifact only — the canonical, reusable
script a human runs.

## Pre-flight verification against the live repo

Read, in full, before writing anything:

- `docs/implementation_plans/V3.2_Implementation_Plan.md`'s Task 9 section, Decisions, Scope, and
  Definition-of-done sections, plus `docs/scope_summaries/V3.2_Scope_Summary.md` Section 2 item 1
  for framing.
- All eight prior task reports (`docs/reports/v3.2/task-1-report.md` through `task-8-report.md`),
  to know exactly what was built, what deviated from the plan's literal prose (Task 1's
  `onSignedIn(session)` signature change in particular, since the script's steps reference that
  callback's real behavior), and — critically — that Tasks 5, 6, and 8 each independently hit the
  same sandbox write-safety block and left their migrations/Edge Function changes unapplied/
  undeployed against the live project. This is the reason the script needs a hard Prerequisites
  gate, not just a QA checklist.
- `docs/Multi_Step_Plan_Execution_Workflow.md`, confirming this task is exactly the kind the
  workflow doc calls out as "explicitly a manual/human step" and should be handed back rather than
  attempted.
- The actual current UI surfaces the script's steps had to describe accurately rather than guess:
  `StudyRoomPanel.tsx`, `TempPasscodePanel.tsx`, `UnlockRequestPanel.tsx`, `FriendsTab.tsx`,
  `SettingsTab.tsx`, `FriendGroupPanel.tsx` and its `friendGroupPanel/` subcomponents
  (`DigestSection.tsx`, `NudgeSendForm.tsx`, `ProducerTagSection.tsx`), `OnboardingWizard.tsx`,
  `AccountPage.tsx`, `PrivacyPolicyPage.tsx`, `SignInForm.tsx`, `TabBar.tsx`, and
  `generate-livekit-token/index.ts` — read each in full rather than trusting Task 2/5/6/7/8's
  reports' prose about exact copy, so the script's quoted sign-in-prompt strings, button labels,
  and tab names are pulled from the real shipped code, not paraphrased.
- `snufflestudy/scripts/verify-digest.mjs`, `verify-study-rooms.mjs`, and `apply-migrations.mjs` in
  full — for the exact test-account creation convention (`admin.auth.admin.createUser(...,
  email_confirm: true)` + password sign-in, ephemeral/auto-confirmed, cleaned up at the end) these
  automated scripts already use, and — more directly useful for a human-run script — the exact
  mechanism already in this repo for applying pending migrations to the live database
  (`node scripts/apply-migrations.mjs`, idempotent via a `_migrations` tracking table).
- `supabase/migrations/20260815000032_v3.2_account_deletion.sql` in full, to get the real,
  authoritative fourteen-table + `auth.users` list and exact column names for the verification SQL
  in item 9 (rather than copying the plan's own stale twelve-table list, which Task 8's report
  already flagged as short by two tables — `nudges`, `coaching_message_requests`).

## What I built

**`docs/qa/V3.2_Two_Account_QA_Script.md`** (new; created the `docs/qa/` directory) — the canonical
QA script. Structure:

- A **Run Log** table at the top (date / branch-commit / tester / result / notes) — appended to on
  every future run rather than forking a new copy of the document, so this stays the one reusable
  artifact the plan's DoD asks for ("saved somewhere this project reruns on future releases, not
  thrown away after this one").
- A **Prerequisites** section, front and center, covering exactly the three pending migrations
  (`20260815000030`/`31`/`32`, linked by path) and the two Edge Functions needing (re)deploy
  (`generate-livekit-token` — changed by Task 6, not new; `delete-account` — new in Task 8), with
  the actual commands to apply them (`node scripts/apply-migrations.mjs`, `supabase functions
  deploy <name>`) and a concrete way to confirm each landed. Also covers needing two *real* email
  inboxes (OTP sign-in sends real mail — unlike the `verify-*.mjs` scripts' auto-confirmed
  password-based test accounts) and two genuinely separate browser profiles (chrome.storage.local/
  IndexedDB are per-install, not per-Supabase-session).
- Nine numbered checklist items, each with concrete UI steps (exact tab names, exact quoted button/
  prompt copy pulled from the real source) and a `Result: ☐ Pass ☐ Fail — Date — Tester — Notes`
  line:
  1. Onboarding sign-in end to end (Tasks 1–4) — wrong code, request-a-new-code, successful round
     trip, using Account A.
  2. "Skip for now" + all five of Task 2's signed-out gates (Study Room, nudge-send, digest,
     temp-passcode approval, unlock-request approval), using Account B, ending by actually signing
     in through one of the inline prompts to confirm it isn't just decorative.
  3. Friend group live status (create/invite/join/list-members).
  4. Nudges arriving in a second account's actually-open UI.
  5. Unlock request approval by a second account (approve and deny paths).
  6. Daily digest visibility — Task 5's fix specifically: B with `share_distraction_attempts` off
     toward A sees `distraction_count: 0` in A's digest while completed/abandoned/recovery stay
     real; A's own read of their own row always shows the real count; turning the toggle on flips
     B's view to the real count too.
  7. Study Room audio/video between two real participants, plus Task 6's fix: a departed
     participant's presence updates for the remaining participant, and rejoining after leaving still
     mints a fresh token cleanly (not permanently locked out by the unified check).
  8. Producer Tag delivery, friend-to-friend and into a room (live Realtime broadcast, not the poll
     alarm).
  9. Account deletion (Task 8), run **last**, with an explicit "never run this against Account A or
     B" warning, using a disposable throwaway account. Includes a ready-to-run verification SQL
     query (all fourteen tables plus `auth.users`, `union all`'d, each expected to return `0`) built
     directly from the account-deletion migration's own `delete from`/`update ... set ... = null`
     statements — not the plan's original, shorter table list — plus a Storage-bucket check and a
     friend-group-ownership-reassignment check (shared group survives with reassigned ownership vs.
     a sole-membership group being deleted outright, per that migration's own two-branch logic).
- A **Final sign-off** section tying a clean run of all nine items (plus confirmed-live
  Prerequisites) to the actual gate the plan cares about: `v3.2` is mergeable into `main` only after
  this passes, and merging itself is explicitly a separate, later, human action this script doesn't
  perform.

No source code was written or modified — this is a documentation-only deliverable, per this task's
own scope.

## Judgment calls

1. **Ordered the nine checklist items for a smooth single walkthrough rather than the plan's
   Deliverables bullet order.** The plan lists digest/rooms/etc. before onboarding; I put onboarding
   first (items 1–2) because a human running this script top-to-bottom needs both accounts signed
   in before any other item works, and item 2 doubles as the natural place to exercise Task 2's
   signed-out gates (walking Account B through onboarding via "Skip for now" is what puts it in the
   right signed-out state to actually see those prompts, rather than manufacturing a separate
   signed-out account just for that one check). Account deletion stays explicitly last, matching the
   plan and the task brief's own "since it's irreversible" framing.
2. **Included all five of Task 2's gated surfaces in item 2**, not just the two the plan's own Task
   9 Deliverables bullet names ("Study Room, temp-passcode request") — the dispatch for this task
   explicitly asked for "Study Room, temp-passcode request, unlock-request approval, nudge/digest
   sections," which also matches the plan's own broader Definition-of-done language ("every panel
   with a friend-facing social feature... shows a real sign-in prompt"). Went with the fuller,
   explicitly-requested list rather than the narrower Deliverables-bullet phrasing.
3. **Wrote the account-deletion verification SQL against the real fourteen-table list** (from
   `20260815000032`'s own header/body), not the plan's original twelve — matching Task 8's own
   documented correction. Using the plan's stale list would make the QA script's own "proof of
   deletion" step incomplete in exactly the way Task 8's report already flagged and fixed at the
   migration layer; carrying the stale list into the QA script would have silently reintroduced that
   gap one layer up.
4. **Called out the setup-vs-regression distinction explicitly at the top of items 6, 7, and 9** —
   each of those items' first sentence says "if this fails because Prerequisites weren't done, that's
   a setup gap, not a Task 5/6/8 regression." This is deliberate: a first-time human runner without
   this framing could easily misdiagnose a missing-migration 404 as evidence the feature is broken
   and file a false regression, when the actual code was already reviewed, tested, and merged three
   tasks ago — only the live-database step never landed.
5. **Specified two separate browser profiles, not two tabs**, as a hard prerequisite, with the
   reasoning spelled out (`chrome.storage.local`/IndexedDB are per-install). This wasn't asked for
   explicitly but is necessary for the script's own item 6 (digest visibility) and item 7 (two
   simultaneous LiveKit connections) to actually test what they claim to — sharing one profile would
   make several "two independent accounts" checks meaningless even if a human followed every other
   step correctly.
6. **Did not attempt to research live Chrome Web Store policy requirements or otherwise touch
   Task 8's deployment-readiness content** — out of scope for Task 9, which validates the *feature
   set*, not the store-submission checklist (that's Task 8's own already-flagged "needs product/
   legal review" follow-up, untouched here).

## What I verified

- `git branch --show-current` → `v3.2`; `git log --oneline -11` → matches the dispatch's expected
  history (`d6d4e43` Task 8 at the top).
- `npx vitest run` (full suite, from `snufflestudy/`) → **85 files, 819 tests, all passed** —
  identical to Task 8's own reported baseline, confirming this task's documentation-only work
  touched zero test-covered source.
- `npm run compile` (`tsc --noEmit`) → clean, no output, no type errors.
- `git status` → only `docs/qa/` (new, untracked) plus the same pre-existing, session-predating
  uncommitted modification to `docs/Multi_Step_Plan_Execution_Workflow.md` that every task report
  from Task 2 onward has already flagged (confirmed by diffing it — it's the workflow doc's own
  "chain automatically, don't stop for review" rewrite, unrelated to this task, present before this
  session started). Left out of this commit for the same reason every prior task's report gave.
- Manually re-read the finished `V3.2_Two_Account_QA_Script.md` end to end against each of the nine
  required-coverage items in the plan's Task 9 Deliverables list and the task dispatch's own
  restated list — confirmed one-to-one coverage, nothing missing, nothing invented beyond what's
  actually shipped in this codebase.

## What's explicitly left for the human

Everything the script itself describes: applying the three pending migrations, deploying the two
Edge Functions, creating/using two real accounts in two real browser profiles, and walking through
all nine checklist items with actual sign-in emails, actual camera/mic access, and actual
irreversible account deletion at the end. None of that was performed by this session, per this
task's explicit scope and the sandbox's write-safety restrictions (consistent with Tasks 5/6/8's
own "not live-verified" sections).

## What's open

- The script has never actually been run — its own Run Log table is empty except for a blank `v3.2`
  placeholder row, by design (a human fills it in on the first real run).
- Task 5/6/8's "live DB verification" gaps (flagged in their own reports) are exactly what this
  script's Prerequisites section and items 6/7/9 are designed to finally close — but only once a
  human actually executes it.
- Nothing else within Task 9's own scope is incomplete — the deliverable the plan asks for (one
  canonical, reusable, saved QA script covering every named item) exists at
  `docs/qa/V3.2_Two_Account_QA_Script.md`.
