# V3.3 Task 15 report: extend the two-account QA script (documentation half only)

**Branch:** `v3.3` (already checked out, per the calling instructions — did not create or switch
branches). Tasks 1–14 already landed (`c472385` through `28d2f3c`, per `git log --oneline`). This
task's scope is explicitly limited to the documentation half of Task 15 — extending
`docs/qa/V3.2_Two_Account_QA_Script.md` in place — **not** running any part of it, signing into any
account, deploying anything, or touching the live Supabase project. That boundary was respected
exactly; see "What I deliberately did NOT do" at the end.

## Pre-flight reading, before writing anything

Read, in full: Task 15's own block in `docs/implementation_plans/V3.3_Implementation_Plan.md`
(Goal/Depends on/Deliverables/Definition of done), the entire existing
`docs/qa/V3.2_Two_Account_QA_Script.md`, and all thirteen prior task reports in
`docs/reports/v3.3/` (task-1 through task-14, no task-4 exists — the plan has no Task 4). Then
cross-checked specific button/heading/copy text directly against current source, rather than trusting
any report's paraphrase, for everything that ended up in a literal "click this" instruction:
`SignInForm.tsx` (exact mode names — `choice`/`create-email`/`create-code`/`create-password`/
`signin-choice`/`signin-password`/`signin-otp-email`/`signin-otp-code` — and exact button/copy
strings), `StudyRoomPanel.tsx` (the `ManageAccessSection` component, the media-toggle buttons, the
"Rooms among your friends" heading, the Archive button), `SettingsTab.tsx` (the four-item nav and
its exact button labels), `TempPasscodePanel.tsx`/`UnlockRequestPanel.tsx` (unchanged signed-out-
gate copy, confirmed still accurate post-Task-1-move), `EndSessionControl.tsx` and
`SessionEndRequestPanel.tsx` (exact status labels, button copy, and the deliberate no-display-name
gap Task 12's report flagged), `AccountPage.tsx` (the "Invite a friend"/"Add a friend"/"Your
friends"/"Password" sections' exact copy), `FriendsTab.tsx` (confirmed panel composition order:
Study Rooms, Friend activity, Temporary passcode requests, Unlock requests, Session-end requests),
and `LockedPage.tsx` (the message-field copy and placement). Also confirmed directly:
`supabase/migrations/` ends at `20260815000039_v3.3_study_room_invitees.sql` and
`supabase/functions/` no longer contains `redeem-temp-passcode` (deleted per Task 10) but still
contains `approve-temp-passcode` (trimmed, not yet redeployed per Task 10's report).

This surfaced several places where the plan's prose and the actual landed UI differ in ways that
mattered for writing accurate steps — all resolved in favor of the real source, per the calling
instructions:
- Task 5's report documents copy changes beyond the plan's literal list (e.g. "Rooms in your
  groups" → "Rooms among your friends", "Friend list ID", "Leave"/"Yes, leave") — used the real
  strings, not the plan's narrower quote list.
- Task 13's report documents the exact "Manage access" UI shape (an expandable per-room section with
  Invite/Remove access toggles, one expanded at a time) and three live-reproduced RLS bugs (a
  mutual-recursion cycle, an unscoped `left_at` clause) that don't change what a QA tester clicks but
  do explain *why* the "not disconnected while active, but blocked from rejoining" negative case
  needs to be checked as two separate halves (item 12, steps 6–7).
- Task 14's report documents the exact `SignInForm` mode names and the fact that `onSignedIn` only
  fires after `AUTH_SET_PASSWORD` succeeds in the create-account branch — used to write item 1's and
  item 17's step-by-step accurately (the wizard genuinely does not advance to "Meet Snuffles" until
  the password step completes).
- Task 12's report flagged that `SessionEndRequestPanel.tsx` deliberately does not resolve a display
  name (unlike every other Task-8-wired panel) — called this out explicitly in item 14, step 3, as a
  known gap, not something to fail the item over.

## What I added: new items 10–20

The plan's Task 15 Deliverables block lists eleven bullets (Settings sub-nav; archived rooms;
invite-only rooms negative case; friending copy; bunny/human name negative case; study-room video
sizing/mirroring/camera-mic toggles; 8-digit code; password auth; temp-passcode redesign negative
case; temp-passcode message; temporary pass to end early negative case) — one new item per bullet,
numbered 10–20, each ending in the file's existing `**Result:** ☐ Pass ☐ Fail — Date — Tester` /
`**Notes:**` format. Every negative case is its own explicit, separately-labeled step within its
item (matching how the existing item 7's Task 6 sub-check and item 9's whole structure already do
this) — e.g. item 12 (invite-only rooms) has the negative case as its own step 2, clearly marked,
before the positive invite flow; item 18 (temp-passcode) and item 20 (session-end) each have their
negative case as an explicit final step with concrete `chrome.runtime.sendMessage` console commands
a human tester can actually run (since neither negative case has a natural UI path — the whole point
is that no UI ever lets you target someone else's request id).

Two of these items needed judgment calls beyond directly transcribing the plan:
- **Item 13 (friending copy)** uses two brand-new, single-use disposable inboxes rather than
  Account A/B, so exercising a genuine create→join→leave cycle doesn't destroy A/B's already-
  established friend connection that items 3 onward assume still holds.
- **Items 14 and 18 (bunny/human name and temp-passcode negative cases)** need a signed-in
  "stranger" account — someone with no friend connection to A or B at all, not just a non-invited
  group-mate — since Account B is already established as A's friend by item 3. Rather than
  introducing a fourth named account, I reused the existing item-9 throwaway account for this dual
  role (documented at length in the updated Prerequisites, see below), since item 9 already runs
  last and its own step 2 is what first gives that account a friend connection — so it stays a
  genuine stranger for the entire run up to that point.

## Prerequisites section updates

- **Migrations:** documented that the seven V3.3 migrations (`20260815000033`–`39`) were already
  applied to the live dev Supabase project during the implementation run itself (each task that
  touched one applied it live and ran a real verification script, per their own reports), but added
  an explicit, unchecked confirmation step for a human to verify this on whatever project the actual
  QA run targets — since a different/fresh project would not have them yet.
- **Edge Functions:** documented that `approve-temp-passcode` (trimmed by Task 10) must be
  redeployed and `redeem-temp-passcode` (deleted from the repo by Task 10) must be removed from the
  live project too — neither has been done yet, per Task 10's own report's "What's deferred to Task
  15" section, which also documents the exact live HTTP 500 this causes today if skipped. Matched
  the existing Prerequisites section 2's format exactly (checklist, `supabase functions deploy`/
  `delete` commands, a final confirmation checkbox).
- **Accounts:** decided the script needs, at most, four roles total across a full run — Account A,
  Account B, the existing item-9 throwaway/stranger account (now doing double duty for items 14/18's
  negative cases, with an explicit warning not to give it a friend connection before item 9 runs),
  and two brand-new single-use disposable inboxes scoped entirely to item 13's own create/join/leave
  cycle (not part of the persistent roster, described inline in that item instead of bloating
  Prerequisites further). Documented all of this in Prerequisites section 3.

## Existing items updated in place: 1, 2, 3, 5, 7, 9

- **Item 1** (onboarding sign-in): rewritten to walk the Create-account branch specifically (a fresh
  install is definitionally creating a new account) — entry-state choice buttons, 8-digit copy, and
  the new mandatory password step (including its genuinely-disabled-submit check) inserted as new
  steps 5–6, matching `SignInForm.tsx`'s actual `create-email → create-code → create-password` mode
  chain.
- **Item 2** (skip + signed-out gates): added the three panels Task 1/12 moved/added into the Friends
  tab (Temporary passcode requests, Unlock requests, Session-end requests) to the per-panel copy
  checklist in step 2, updated the "Send a nudge" copy for Task 5's relabel, and replaced the old
  "open the Settings tab, check two panels" step 3 with a check of the new Settings sub-nav's own
  signed-out state (Account sub-view shows the sign-in choice; Friends sub-view's own "Sign in on the
  Account page..." button correctly switches the sub-nav).
- **Item 3** (friend group live status): rewritten for Task 5's collapsed one-click "Invite a friend"
  flow and the "Add a friend"/"Your friends"/"Friend list ID" relabels — noted the underlying
  `GROUP_CREATE`/`GROUP_JOIN`/`GROUP_LIST_MEMBERS` calls are unchanged.
- **Item 5** (unlock request approval): one-line change — step 3 now points at the Friends tab, not
  Settings, per Task 1's move.
- **Item 7** (Study Room): added a new step 1a (invite B via "Manage access" before B can see the
  room at all, per Task 13), updated the "Rooms in your groups" → "Rooms among your friends" copy,
  and added an explicit cross-reference to item 15 for video sizing/mirroring/toggle checks (not
  re-tested here, to avoid duplicating item 15's more thorough walkthrough) and to item 12 for the
  invite-only mechanics themselves (this item stays focused on live audio/video quality).
- **Item 9** (account deletion): added `profiles`, `session_end_requests` (both `requester_user_id`
  and `resolved_by`), and `study_room_invitees` (both `user_id` and `invited_by`) to the negative-
  case SQL query — five new `union all` lines — per what Tasks 8/12/13's own `delete_account_data()`
  fixes actually added (confirmed against each task's report, which each independently reproduced a
  live "Database error deleting user" failure before fixing it). Updated the "fourteen" table count
  in the surrounding prose to "seventeen". Also updated step 2 (what to give the throwaway account to
  delete) to include a bunny/human name, a session-end request in both directions, and a study-room
  invite in both directions — otherwise step 6's new query lines would trivially show zero rows for
  reasons unrelated to the deletion working. Added an explicit note that this item must now run
  after item 20, not right after item 8, given its throwaway account's new dual role in items 14/18.

**Items 4, 6, 8 deliberately left untouched** — confirmed via the plan's own Scope section that no
V3.3 task touched nudges, daily digests, or Producer Tags.

## An honesty adjustment beyond the letter of the instructions

Items 1, 2, 3, 5, 7, and 9 each already carried a recorded "☑ Pass — 2026-08-24 — Chloe Chan" result
line from the real V3.2 run. I did not touch those Pass/Date/Tester markers (per the explicit
instruction not to touch anything representing a completed run) — but since I materially changed
several of these items' steps to include V3.3-specific checks that were never actually exercised on
2026-08-24 (the password step, the moved panels, the relabeled copy, the invite-only precondition,
the three new deletion tables), leaving a bare "Pass" next to genuinely new, unverified steps would
read as claiming those new checks already passed. I added one clarifying sentence to each of these
six items' **Notes:** line stating plainly that the recorded Pass predates the V3.3 changes listed
above and that those specific new/changed steps still need a fresh live run. This didn't alter the
Pass/Date/Tester fields themselves or the Run Log table — only added truthful context in the
Notes field, which the file's own instructions already ask contributors to fill in.

## Other small fixes made while extending the document

- The title/intro paragraph now states the document covers both V3.2 and V3.3, names which items are
  new (10–20) versus updated in place (1, 2, 3, 5, 7, 9) versus untouched (4, 6, 8), and still states
  the "human step, no agent execution" boundary up front.
- Prerequisites section 3's stale "a real 6-digit code" reference was updated to note the code is now
  8 digits as of Task 2, cross-referencing item 16.
- "How to use the checklist below"'s "blocks merging `v3.2` into `main`" line was generalized to
  "the branch under test," since the document is now explicitly multi-release.
- Added a note to Final sign-off (not a checkbox change) stating that a `v3.3` run's sign-off
  requires all twenty items, not just the original nine — left every existing checkbox and the
  2026-08-24 deliberate-exception note exactly as they were.

## What I verified

- `npm run test` (from `snufflestudy/`): **91 files, 1001 tests, all passed** — unchanged from Task
  14's own final count, confirming this documentation-only change broke nothing (as expected, since
  only one Markdown file was touched).
- `npm run compile` (`tsc --noEmit`): clean.
- `git status --porcelain`: only `docs/qa/V3.2_Two_Account_QA_Script.md` (this task's work) and
  `docs/Multi_Step_Plan_Execution_Workflow.md` (pre-existing, unrelated in-flight work per every
  prior report in this run) show as modified.
- Re-read the full final document end to end after all edits to confirm heading numbering is
  sequential (1–20, plus Run log/Prerequisites/Final sign-off), every new item ends in the exact
  `**Result:**`/`**Notes:**` format the existing items use, and every negative case reads as its own
  explicit, separately-labeled step rather than folded silently into a positive-path step.

## What I deliberately did NOT do

Per this task's own strict scope: did not sign into any account, real or test; did not run
`supabase functions deploy`/`delete` against the live project; did not apply, confirm, or query
anything against the live Supabase database (no `pg`/`supabase-js` calls of any kind); did not
execute any step of the QA script itself. Every claim in this report and in the extended script
about what's "already applied" or "already deployed" live is sourced from reading the thirteen prior
task reports and the repo's own migration/function files — not from any live check performed by this
task. Confirming those claims against whatever project a real QA run targets is explicitly left to
the human tester, per the Prerequisites section's own new checkboxes.

## Open question for the human running this script

None beyond what's already flagged inline in the document itself (the Prerequisites' unchecked
confirmation steps, and the six items' Notes lines noting which specific new steps still need a
live run). No live-DB or live-account question came up during this task that I was unable to answer
from the existing reports and source — the boundary in this task's instructions was never actually
tested, since nothing required touching Supabase to write accurate QA steps.
