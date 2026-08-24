# SnuffleStudy V3 Scope Summary

**Purpose of this document:** catalog everything left to implement, right now, across three sources — the manual verification `docs/V2_Implementation_Plan.md`'s Task 15 explicitly couldn't finish by itself, the non-blocking backlog the v2 final whole-branch review left open on purpose, and two new feature requests that arrived after v2. Nothing here is a build plan yet. It plays the same role for what comes next that `docs/V2_Scope_Summary.md` played for v2: review it, answer the open questions, and a real task-by-task plan (per `docs/Implementation_Plan_Guidelines.md`) can follow.

**Where v2 actually stands, for context:** branch `v2` is 45 commits ahead of `main`, all 15 tasks in `docs/V2_Implementation_Plan.md` are built, and the final whole-branch review's one Critical and six Important findings are resolved down to three intentionally-deferred items (below) — two of which (group-leave, and the default-false privacy columns) were built as user-approved follow-ups after the review flagged them as product decisions rather than bugs. `v2` was marked ready for PR. So "left to implement" below is genuinely the remaining list, not a euphemism for "v2 isn't done."

---

## Group A — Manual two-account testing

**What's asked:** friend live status, nudges, unlock approval, digest, Study Room video, Producer Tag playback — needs real hands, can't be automated.

**Why it can't be automated:** every one of these was proven at the data/authorization layer by the project's own live verification scripts (241/241 checks across 11 `scripts/verify-*.mjs` scripts, re-confirmed clean in the Task 15 regression pass). What's *not* provable by a single automated session is the two-person, real-time experience: a second concurrent account actually seeing an update land in its own open UI. Specifically:

- **Friend group live status** between two real, concurrently open accounts.
- **Nudges** arriving in a second account's actual open side panel in real time.
- **Unlock request approval** by a second account.
- **Daily digest** delivery/visibility to a second account.
- **Study Room video/audio** — real camera/mic capture, transmission, and rendering between two participants. (LiveKit token minting/scoping and Realtime presence were proven live at the data layer; actual audio/video was not, and structurally cannot be by one operator.)
- **Producer Tag delivery** (friend-to-friend and into-a-room) actually arriving and being audible in a second account's real open UI.
- Lower priority: **visually** watching `SnufflesOverlay` swap from the static warning line to the AI-generated one on a live restricted-site visit — the underlying logic (both the network-on and network-off paths) is already proven independently; this is purely a "watch it with your own eyes" confirmation. It's blocked on the same obstacle as the others plus one more: `chrome.permissions.request`'s native OS-level prompt can't be clicked through by headless automation at all.

**Drawbacks of the current state:** this isn't a testing gap that automation will eventually close — video/audio calling and true multi-account real-time delivery are inherently outside what one operator, one machine, and one browser session can verify. That's a permanent property of this class of feature, not a temporary tooling limitation.

**Ways to improve this going forward:**
- Turn the six-item list above into a standing, literal step-by-step QA checklist (two browser profiles or two devices, exact clicks, exact expected results) rather than re-deriving it ad hoc each time a review flags it — the project already has three separate documents that each partially describe it (the V2 plan's Task 15 checklist, the final review, and the Task 15 report); worth consolidating into one canonical script.
- For the Study Room A/V check specifically, it's worth a short spike into Chrome's `--use-fake-ui-for-media-stream` / `--use-fake-device-for-media-stream` launch flags, which let Playwright grant camera/mic permission and feed a synthetic video/audio stream without a human present. That wouldn't prove real hardware works, but it could automate the LiveKit connection/track-negotiation path (distinct from what `verify-study-rooms.mjs` already proves at the presence/token layer) — a meaningfully cheaper regression check than "get a second human" every time this code changes.
- Everything else on the list is a genuine two-human requirement with no realistic path to automation; the honest ask is scheduling, not tooling.

**Priority:** do this before treating v2 as done for real users. These six items are literally what the whole Accountability phase exists to deliver — the parts of the product a solo automated pass structurally cannot confirm.

---

## Group B — Backlog from the v2 final review (non-blocking, left open on purpose)

Three items were explicitly identified by the final whole-branch review as legitimate follow-up work, not merge-blocking, and deliberately left untouched (distinct from two sibling findings — group-leave and the privacy-column defaults — that *were* built as follow-ups once the user weighed in on them).

### B1. Daily-digest visibility doesn't respect the same privacy toggles session events do

Task 10 built field-level visibility toggles (goal text, time remaining, distraction attempts, current domain, intervention count) enforced by Postgres RLS on `session_status_events` — live nudges and the friend-activity feed all respect them. The daily digest's aggregation (`compute_daily_digests()` / `digestApi.fetchDigestForDate`) reads the same underlying event data but was built before — and never wired into — those toggles. A friend who has, say, distraction-attempt visibility turned off can still have distraction counts surface via the digest, because the digest aggregates directly rather than going through the same gate the live event path already has.

**Drawback:** this is a real privacy inconsistency, not a cosmetic one — the product's whole selling point is *consensual* visibility ("default to minimal visibility," stated as a hard Global Constraint in `docs/V2_Implementation_Plan.md`), and right now one of two delivery paths for the same underlying data quietly doesn't honor a user's stated choice.

**How to fix it:** extend the aggregation (or a view/RLS layer in front of it) to consult the same `friendship_settings` field toggles `session_status_events`' policy already reads — ideally by factoring the visibility check into one shared helper both paths call, rather than the two independently-written checks that let this gap open in the first place. Add a negative test alongside the existing `verify-digest.mjs` suite: toggle a field off, confirm the digest omits or zeroes it for that viewer.

**Priority:** the more urgent of the two functional backlog items — it's a privacy leak against the product's own stated guarantee, not just rough UX.

### B2. Leave-room semantics differ slightly between two layers

`studyRoomApi.leaveRoom()` sets `left_at` on the caller's `study_room_participants` row — that's the RLS/database layer's notion of "who's still in the room." The `generate-livekit-token` Edge Function, which actually mints a usable video-call access token, has its own separate check of the same `left_at` column, written independently, that can drift out of sync with the database layer's behavior over time (e.g. if one side's query changes and the other doesn't).

**Drawback:** two independently-maintained implementations of "is this user currently an active participant in this room" is a latent bug waiting to happen — either a departed user retains the ability to mint a token into a room's video channel, or a still-present user gets incorrectly rejected. Neither has been observed live, but the structural risk is real precisely because nothing forces the two checks to agree.

**How to fix it:** extract the "active participant" check into a single Postgres function or view that both the RLS policy and the Edge Function query — one source of truth, so a future change to the definition of "active" only has to happen once.

**Priority:** should close before Study Rooms sees meaningful real traffic — it's the single largest infrastructure investment in the whole v2 effort (a hosted video SDK), so its edge cases deserve a clean, unified story rather than two versions of the truth sitting side by side.

### B3. `FriendGroupPanel.tsx` has grown large enough to want splitting

567 lines covering five distinct concerns in one component: the friend-event feed, nudge send/receive, daily digest cards, Producer Tag record/send/incoming playback, and the panel's own friend-discovery/data-fetching logic (`loadEvents`, `loadFriends`, `loadNudges`, `loadDigests`, `loadProducerTags`). The review's own framing: it's "crossed from 'flag for later' to 'needs splitting.'"

**Drawback:** harder to test any one concern in isolation, harder to reason about what re-renders when, and a real risk for whoever (human or a future Claude session) next needs to touch one piece without fully understanding the other four first.

**How to fix it:** this is a mechanical refactor, not a design problem — the file already visually separates each concern into its own `<section>`. A natural split: keep `FriendGroupPanel.tsx` as a thin container, extract `IncomingNudgeCard`, `DigestCard`/digest section, `NudgeSendForm`, a Producer Tags section, and the friend-event feed into their own files, and pull the five `load*` functions plus their state into a `useFriendGroupPanelData()` hook.

**Priority:** lowest-risk item on this whole list — no user-facing behavior changes, pure maintainability. Good first task of a next work session precisely because it's cheap and safe, and worth doing before the file picks up a sixth concern (e.g. Study Room membership status) and gets harder to untangle.

*(The review's full findings list also included assorted lower-severity "Minor" items beyond these three headline follow-ups; they weren't individually itemized into a tracked backlog and aren't reproduced here — worth a quick pass through the review commits under `.superpowers/sdd/V2_Implementation_Plan/` if a fuller cleanup pass is ever scheduled.)*

---

## Group C — New feature requests (not yet planned)

### C1. A real, draggable, click-to-open bunny on the page

**What's asked:** put the actual bunny image on the screen. No animation for this version — a still placeholder image the user can drag around, that stays where it's dropped. Clicking it opens the side panel.

**Current state (confirmed by reading the code, not assumed):** the placeholder-art system this needs already exists and is exactly as simple as it should be — `animationRegistry.ts` defines one static PNG per wellness state (`frameDurationMs: 0`, i.e. genuinely "no animation, just a still image," matching the architecture doc's own placeholder-asset design). But `SnufflesOverlay.tsx` only mounts that image inside the distraction-warning content-script overlay, and only when the current page is classified `BLOCKED` — it is not a persistent, always-visible companion. Once a warning is dismissed it falls back to rendering the same image in an "idle" state, but:

- It isn't draggable. `movementController.ts` — which computes a starting `{x, y}` per movement preference (`free`, `bottom-edge`, `bottom-only`, `static`, `hidden`) — exists but has zero call sites anywhere in the app. It's dead code today.
- Nothing persists a dragged position.
- Nothing responds to a click by opening the side panel.

**What actually needs building:**
1. Decide the companion's mount condition — most likely "render whenever a session is `FOCUSING` or `BREAK`," not gated to a `BLOCKED` classification, so it behaves like a persistent desktop companion rather than only appearing when something's wrong.
2. Real pointer-drag handling (`pointerdown`/`pointermove`/`pointerup`, or the older mouse-event trio) updating the image's on-screen position, using `movementController.initialPosition()` as the starting point for the user's movement preference rather than replacing it.
3. Persist the dragged position so it "stays there" — `chrome.storage.local` is the natural fit, consistent with how the rest of the extension already stores state.
4. An `onClick` handler calling the same `chrome.sidePanel.open()` path `PopupApp.tsx`'s "Start a session" button already uses.

**Drawbacks / design questions worth deciding explicitly, not defaulting into:**
- *Per-tab vs. persistent position.* The architecture's own content-script design mounts a fresh overlay per eligible tab ("each eligible tab may receive its own Snuffles renderer"). A naive drag implementation would reset to a default corner on every new page load, which likely isn't what "stays there" means to the person asking. Persisting position centrally (keyed by user, not by tab) is a small addition, but it's a real decision, not an obvious default.
- *Drag vs. click conflict.* Needs a small movement threshold (e.g., "moved less than ~5px counts as a click, not a drag") so a user nudging the bunny doesn't accidentally lose the ability to open the side panel, and vice versa.
- *Where it can be dragged to.* Should the bunny be draggable off-screen, or constrained to the viewport? Constraining avoids a bunny a user can't find again without reloading.

**Why this is comparatively cheap:** no backend dependency, no new art assets (the architecture overview already scoped "hand-drawn frame-by-frame animation" and a real Figma design pass as future work, unrelated to this version), and it's wiring together two pieces (`movementController.ts`, the existing placeholder image) that already exist in isolation. This is a self-contained, local-only content-script task.

**Priority:** no dependency on anything else in this document — could ship any time, and is a good high-visibility, low-risk win, since today the bunny is invisible unless something's already gone wrong. Making it a persistent, interactive companion is arguably closer to the product's actual pitch ("a friend group enforcing a commitment... a playful but strict intervention layer") than its current on-again-off-again presence.

### C2. Sign in / create an account before session setup, using Supabase

**What's asked:** instead of onboarding opening with questions like goal and focus duration, ask the user to log in or create an account first — using Supabase — so friend interaction can actually happen.

**Current state (confirmed by reading the code, not assumed):** Supabase Auth is already fully built, just not where this request wants it. `AccountPage.tsx` (reached via Settings → Account) has a complete, tested email one-time-code sign-in flow (`AUTH_REQUEST_OTP` → `AUTH_VERIFY_OTP` → `AUTH_SIGN_OUT`) plus friend-group create/join/leave, all wired to a real Supabase project. But `OnboardingWizard.tsx`'s step order is unchanged from v1: Welcome → "Meet Snuffles" → pressure style → duration → tracking tier → sites (if detailed) → optional passcode → finish. There is no authentication step anywhere in it. A user can complete onboarding and run local sessions entirely signed out, and only hits Supabase sign-in later, if and when they go looking for the Friends section in Settings.

**What actually needs building:** a new onboarding step reusing `AccountPage`'s existing `AUTH_REQUEST_OTP`/`AUTH_VERIFY_OTP` message contract (either by extracting a shared `<SignInForm />` both `AccountPage` and the new step render, or a comparable reuse — not a second, independently written sign-in implementation), inserted early in the flow per the request — most naturally right after the Welcome screen and before "Meet Snuffles."

**Design questions genuinely worth deciding before building, not assuming:**
- **Mandatory or skippable?** Every existing optional step in this onboarding (the passcode step, specifically) was deliberately made skippable, on the reasoning that a user without anyone to share it with yet shouldn't be blocked from finishing setup. Making auth a hard gate on step one is a real reversal of that whole posture, and worth being an explicit, named decision rather than an implied one. If the underlying goal is genuinely "so we can do actual friend interacting" rather than "accounts for everyone," a skippable step that re-prompts only when the user first touches a friend feature would preserve today's low-friction local-only path while still solving the actual problem. Both are legitimate answers — this just shouldn't be decided implicitly by whichever version gets built first.
- **What happens if the user closes the tab mid-verification**, waiting on an email code? Needs an explicit "skip for now, sign in later in Settings" escape hatch so onboarding never feels stuck on an external, uncontrollable step (email delivery).
- **Scope creep risk:** "log in during onboarding" naturally invites "and also create/join my friend group during onboarding" as a next ask — worth deciding now whether this request is *just* the sign-in step, or the sign-in step plus a lightweight group step, since those are meaningfully different amounts of work.
- **Interaction with the existing `friendSyncEnabled: false` onboarding default:** today `OnboardingWizard`'s `finish()` deliberately defers friend sync to later, on the stated reasoning that it's "opt-in and configured separately... not part of the onboarding flow." Moving auth earlier doesn't have to flip that default, but the two decisions are adjacent enough to make together rather than separately.

**Priority:** this is the more consequential of the two new requests — it's a product-identity decision (does first run require an account) wearing the shape of a small UI task. Recommend resolving the "mandatory vs. skippable" question explicitly first, the same way `docs/V2_Implementation_Plan.md`'s own Decisions section resolved every comparably ambiguous call up front rather than leaving it to whoever implements it first. Once decided, the build itself is moderate and self-contained — the hard infrastructure (Supabase Auth) already exists and is already proven.

---

## Group D — Already-known, deferred past v2 (unchanged, listed for completeness)

Nothing new here — these were explicitly named as out of scope in `docs/V2_Implementation_Plan.md`'s Scope section and remain so. Listed so the full remaining-work picture is in one place, not scattered across documents:

- **FCM push notifications** — the delivery upgrade from polling for friend nudges; stays conditional on polling latency actually becoming a real, repeated complaint rather than a theoretical one.
- **Full offline sync** of backend data across devices (conflict resolution) — today's guarantee is only "don't break when offline," which already holds.
- **Multiple-device support.**
- **Cross-browser support** — Chrome MV3 only today.
- **Play Mode expansion** — mini-games, cosmetics, food/toys/room interaction beyond what already exists.
- **Additional Snuffles personalities** beyond the six seeded pressure profiles.
- **Aggregate Analytics dashboard** — charts/trends layered on top of the History/Review screen's already-built raw browsable log.
- **Real hand-drawn animation frames + a Figma-sourced design pass** — today's placeholder art (one static PNG per wellness state) is exactly what C1 above builds on top of, not a replacement for it.

None of these have a concrete trigger to start yet; each was deliberately deferred until there's a real reason to revisit it (e.g., add push once polling latency is an actual complaint, not preemptively).

---

## Suggested overall priority order

Weighing effort against value, and flagging which items need a decision before they can be built at all:

1. **Split `FriendGroupPanel.tsx` (B3)** — cheapest, safest, no product decision required. Good first task.
2. **Fix the daily-digest privacy gap (B1)** — a real privacy inconsistency against the product's own stated guarantee; close it before more users rely on the digest.
3. **Build the draggable bunny (C1)** — cheap, self-contained, high visible impact, no open decisions blocking it.
4. **Run the two-account manual QA pass (Group A)** — do this at or before merge to `main`; it's the actual proof that v2's social features work for real users. Worth a short spike into Chrome's fake-media-stream flags first, to shrink how much of it needs two humans every time.
5. **Fix leave-room semantics (B2)** — close before Study Rooms carries meaningful real traffic.
6. **Auth-first onboarding (C2)** — resolve the mandatory-vs-skippable decision explicitly first (see the open question below); the build itself is moderate once that's settled.
7. **Group D items** — no urgency; revisit individually when a concrete reason arises.

---

## Open questions before this becomes a real plan

1. **C2 — mandatory or skippable sign-in during onboarding?** This is the one decision in this document that changes the shape of the build, not just its polish. Recommend resolving this explicitly before scheduling C2.
2. **C2 — sign-in only, or sign-in plus a lightweight friend-group step?** Adjacent scope-creep risk worth naming up front.
3. **C1 — persist bunny position per-tab or centrally (per user)?** Affects whether "stays there" needs new storage or just local component state.
4. Does Group A's manual QA pass happen before merging `v2` into `main`, or after, treated as a fast-follow? (Recommendation above assumes before.)

Answer what's answerable, and the result can fold into a proper V3 (or "v2 wrap-up") implementation plan, following `docs/Implementation_Plan_Guidelines.md`.
