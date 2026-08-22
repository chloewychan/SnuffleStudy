# SnuffleStudy V3 Scope Summary — Deployment-Ready Completion

**Purpose of this document:** define the work that stands between the current `v2` branch and an extension that is genuinely, fully usable for real users and safe to submit to the Chrome Web Store — no functional gaps, no compliance gaps. Everything here is a **must-ship** for V3. Anything that's a real improvement but not required to call the product done — the draggable bunny, an aggregate analytics dashboard, and the rest — has been split out into `docs/V4_Scope_Summary.md`, which starts only once this document's checklist is clear.

**Where v2 actually stands, for context:** branch `v2` is 45 commits ahead of `main`, all 15 tasks in `docs/V2_Implementation_Plan.md` are built, and the final whole-branch review's one Critical and six Important findings are resolved down to three intentionally-deferred items — two of which (group-leave, and defaulting three legacy privacy columns to `false`) were already built as user-approved follow-ups once the review flagged them as product decisions rather than bugs. `v2` itself was marked ready for PR. The six items below are what's left before that branch is actually ready to reach real users, not a sign v2 is incomplete.

**What "done" means for V3:** a user can install the extension, use every local feature, sign in and use every social feature, and the listing itself is compliant — with nothing left that only works because it hasn't been tested with two real people yet, and nothing left undisclosed that Chrome's own policy now requires disclosed. See the Definition of Done at the end of this document.

**Execution note:** this bar is now being reached in two passes rather than one. `docs/V3.1_Scope_Summary.md` is a deliberately reduced-rigor hackathon-submission slice of the six items below (in practice, almost entirely item 5), buildable in one session. `docs/V3.2_Scope_Summary.md` hardens whatever V3.1 leaves rough and builds everything else on this list. This document remains the source of truth for what the six items actually require in full.

---

## Must ship

### 1. Manual two-account QA and a canonical QA script

**Treat this as a release gate, not a backlog item.** Every item below was already proven at the data/authorization layer by the project's own live verification scripts (241/241 checks across 11 `scripts/verify-*.mjs` scripts). What's never been proven is the two-person, real-time experience — a second concurrent account actually seeing the update land in its own open UI. That gap is exactly what this product exists to deliver, so it can't ship unverified.

**Verify with two real accounts:**
- Friend group live status between two concurrently open accounts.
- Nudges arriving in a second account's actual open side panel in real time.
- Unlock request approval by a second account.
- Daily digest visibility to a second account — **run this one after item 2 below lands**, so the check also confirms the privacy-toggle fix, not just that a digest arrives.
- Study Room audio/video — real camera/mic capture, transmission, and rendering between two participants.
- Producer Tag delivery (friend-to-friend and into-a-room) actually arriving and being audible in a second account's real open UI.

Write this up as one canonical, literal, step-by-step QA script (two browser profiles or two devices, exact clicks, exact expected results) rather than re-deriving it from scratch each time — right now the closest things to it are scattered across `docs/V2_Implementation_Plan.md`'s Task 15 checklist and a couple of internal review reports. Consolidate those into a single script this project reruns on every future release, not just this one.

**The fake-media-stream Playwright spike (`--use-fake-ui-for-media-stream` / `--use-fake-device-for-media-stream`) is optional, and only worth doing if it's quick.** It can automate the LiveKit connection/track-negotiation path for regression purposes, but it proves nothing about real hardware, real network conditions, or the real two-person experience — it supplements the real-device A/V check above, it never replaces it.

**Sequencing:** do this last among the six items, immediately before shipping — it's the check that validates everything else on this list actually works together, including the new auth flow from item 5.

### 2. Fix daily-digest privacy enforcement

Task 10 built field-level visibility toggles (goal text, time remaining, distraction attempts, current domain, intervention count), enforced by Postgres RLS on `session_status_events` — live nudges and the friend-activity feed both respect them correctly. The daily digest's aggregation (`compute_daily_digests()` / `digestApi.fetchDigestForDate`) reads the same underlying session-event data but was built independently, and never wired into those same toggles. A friend who has, say, distraction-attempt visibility turned off can still have distraction counts surface through the digest, because the digest aggregates directly rather than passing through the gate the live event path already has.

**This belongs in V3, not the backlog, because it's a real contradiction of the product promise, not rough UX.** "Consensual peer pressure" and the plan's own Global Constraint ("default to minimal visibility, enforced with RLS") both assume a user's privacy choice actually holds — right now one of two delivery paths for the same underlying data quietly doesn't honor it.

**What to do:**
- Centralize the visibility logic — factor the field-level check into one shared helper (or view) that both `session_status_events`' RLS policy and the digest aggregation call, so the two paths structurally cannot diverge again the way they already have.
- Add negative tests for every hidden field, not just one representative case — especially **distraction attempts** and **goal text**, since those are the two most sensitive fields in the toggle set and the ones most likely to actually embarrass someone if leaked.

### 3. Unify Study Room "active participant" rules

`studyRoomApi.leaveRoom()` sets `left_at` on the caller's `study_room_participants` row — the database/RLS layer's notion of who's still in the room. The separate `generate-livekit-token` Edge Function, which actually mints a usable video-call access token, has its own independently written check of the same `left_at` column that can drift out of sync with the database layer over time.

**Put the definition of an active room participant behind one Postgres function or view, used by both the RLS policy and LiveKit token generation.** This is the fix, full stop — one source of truth instead of two independently-maintained implementations of the same question. It matters specifically because it's the failure mode that would let a former participant retain the ability to mint a valid token into a room's video channel: not observed live yet, but a real structural risk precisely because nothing today forces the two checks to agree, and Study Rooms is the single largest infrastructure investment in this whole plan.

### 4. Split `FriendGroupPanel.tsx`

567 lines covering five distinct concerns in one component: the friend-event feed, nudge send/receive, daily digest cards, Producer Tag record/send/incoming playback, and the panel's own friend-discovery/data-fetching logic (`loadEvents`, `loadFriends`, `loadNudges`, `loadDigests`, `loadProducerTags`).

**Do this early in V3, before the fixes above or QA make the component more complex.** Items 2 and 3 don't touch this file directly, but this is the product's single most important social surface, and it's already large enough that any change to the digest or nudge rendering logic risks a bigger diff and a bigger regression surface the longer the split waits. The file already visually separates each concern into its own `<section>`, so this is a mechanical extraction, not a design problem: keep `FriendGroupPanel.tsx` as a thin container, extract `IncomingNudgeCard`, the digest section, a nudge-send form, and a Producer Tags section into their own files, and pull the five `load*` functions plus their state into a `useFriendGroupPanelData()` hook.

Not flashy, but it lowers the chance of regressions in exactly the surface the rest of this document is asking to change.

### 5. Auth in onboarding: skippable sign-in only

Supabase Auth (email one-time-code sign-in) is already fully built in `AccountPage.tsx` — `AUTH_REQUEST_OTP` → `AUTH_VERIFY_OTP` → `AUTH_SIGN_OUT`, tested and working. It just isn't reachable until a user goes looking for it in Settings. `OnboardingWizard.tsx`'s step order today: Welcome → "Meet Snuffles" → pressure style → duration → tracking tier → sites → optional passcode → finish — no auth step anywhere in it.

**Decision made:** add sign-in immediately after the Welcome screen, but do not require it to finish onboarding.

- Copy should be direct about *why*, not just present a generic sign-in form: **"Sign in to use friends, rooms, nudges, approvals, and synced accountability features."** A user should understand this step is about the social layer specifically, not a general account wall.
- Provide **"Skip for now"**, and route skippers into local sessions exactly as onboarding already does today — nothing about the local-only path changes.
- Gate sign-in again, later, the first time a skipped user actually reaches a social action. Concretely, that means: opening the Friends section in Settings, trying to create or join a group, sending or receiving a nudge, joining a Study Room, or requesting a temporary hard-mode passcode. Each of those entry points should prompt sign-in in the moment, not silently fail or dead-end.
- Reuse one shared sign-in component and message contract — either extract `AccountPage`'s existing form into a `<SignInForm />` both surfaces render, or have the new onboarding step call the exact same `AUTH_REQUEST_OTP`/`AUTH_VERIFY_OTP` messages directly. **Do not build a second OTP flow.**
- Needs an explicit "resume later" path for the case where a user closes the tab mid-verification, waiting on an email code — falls back to "Skip for now" behavior rather than leaving onboarding feeling stuck on an external, uncontrollable step.

### 6. Deployment readiness work

This is genuinely required, not paperwork for later. Chrome Web Store's user-data and privacy-disclosure policy update took effect **August 1, 2026** — already in force as of today — and SnuffleStudy now genuinely touches real user data: account email (Supabase Auth), study session and goal data synced to friends, friend-group membership, nudge messages, daily digest aggregates, recorded audio (Producer Tags, via Supabase Storage), site-classification/hostname data when detailed tracking is on, and session-goal text sent to an AI coaching provider (Anthropic, via a Supabase Edge Function). None of that was true for v1; most of it is new in v2.

Current policy requires, concretely:
- **A published privacy policy is required whenever an extension handles user data in any form** — including data that's only ever stored locally and never leaves the device. It must state what's collected (including anything collected automatically), how it's used, and what's shared, with whom.
- A separate **Limited Use disclosure**, on the extension's homepage or one click away.
- Collected data must be **strictly necessary to the extension's disclosed single purpose**, disclosed prominently in-product, with a requirement to proactively notify users if data-handling practices change after install.
- Requested permissions must match **minimum necessary use** and align with what's actually disclosed — a mismatch between permissions, the privacy policy, and actual behavior is itself a policy violation.

**What this means concretely for V3:**
- Write and publish an actual privacy policy naming every real destination data reaches: on-device storage (`chrome.storage.local` / IndexedDB), Supabase (Postgres, Auth, Storage, Realtime), the Anthropic API (server-side only, via Edge Function), Resend (temp-passcode emails), and LiveKit (video calls). This is a documentation and disclosure task layered on top of an architecture that already isolates every third-party secret server-side (v2's own Global Constraint) — not a re-architecture.
- Add an explicit account-and-data-deletion path: not just "delete local history" (already required by v1's own architecture doc), but a real "delete my account and everything Supabase holds about me" action. The schema's existing per-user foreign keys make this a reasonably contained Edge Function/RPC, not a redesign.
- Audit every manifest permission and host permission against what's actually used, and make sure optional capabilities stay runtime-requested. Current state, read directly from `wxt.config.ts`, is already in good shape: required permissions are `storage`, `alarms`, `notifications`, `idle`, `scripting`, `declarativeNetRequest`, `sidePanel`, and the only broad grant (`*://*/*`) is already `optional_host_permissions`, requested at runtime only when a user opts into detailed tracking. The audit is mostly confirming each permission still maps to a real, disclosed feature — `scripting` for the overlay content-script, `notifications` for nudges/digests, and so on — rather than a rework.
- Because the policy is already in force, an unsubmitted privacy policy, or an audio-recording/AI-coaching feature with no matching disclosure, is a real submission-rejection or takedown risk the moment this extension is actually listed — not a hypothetical future concern.

Sources: [Chrome Web Store policy updates: Enhancing user privacy and platform integrity](https://developer.chrome.com/blog/cws-policy-updates-2026), [User Data FAQ — Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

---

## V3 scope boundary

**Do not add a friend-group creation/join step to onboarding yet.** Authentication and group setup are separate decisions: forcing both on first run makes onboarding feel like registration before the product has demonstrated any value. Let users sign in early (item 5), then show a clear Friends call-to-action after they've completed or started their first session — group creation/joining stays exactly where it already lives today, in Settings → Account, just reachable sooner because sign-in itself no longer requires a trip there first.

---

## Suggested execution order

The six items above are numbered for reference, not sequence. A reasonable build order:

1. **Split `FriendGroupPanel.tsx` (item 4)** — do this first; it's foundational cleanup that makes item 2's digest-rendering changes and any future nudge/tag work land on a smaller, cleaner surface.
2. **Fix daily-digest privacy enforcement (item 2)** — a real privacy leak against a stated guarantee; close it before more people rely on the digest.
3. **Unify Study Room active-participant rules (item 3)** — independent of the above, can run in parallel.
4. **Auth in onboarding (item 5)** — the product-facing centerpiece of this phase.
5. **Deployment readiness work (item 6)** — privacy policy, deletion path, permission audit; do this once the auth flow (item 5) is final, since the privacy policy needs to describe the real, shipped account experience.
6. **Manual two-account QA (item 1)** — last, as the release gate. Run the digest check specifically after item 2, and the sign-in-gated social actions specifically after item 5, so this pass validates the finished behavior, not the old behavior.

---

## Open questions

1. **Exact wording for the later sign-in gate.** Item 5 fixes the *first-run* copy explicitly ("Sign in to use friends, rooms, nudges, approvals, and synced accountability features."). The *later* prompt — when a skipped user first taps Friends, sends a nudge, or tries to join a room — needs its own short copy pass; it should feel like an in-context nudge, not a repeat of the onboarding screen.
2. **Does item 1's QA pass block merging `v2` into `main`, or does it run as a fast-follow immediately after?** The execution order above assumes it's the literal last step before shipping; worth confirming that's also the release process this project wants going forward.

Once these are settled, this document is close enough to task-sized to become a real V3 implementation plan, following `docs/Implementation_Plan_Guidelines.md`.
