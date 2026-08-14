# SnuffleStudy V2 Scope Summary

**Purpose of this document:** catalog everything under consideration for v2 before writing the full implementation plan. It draws from two sources — what `docs/Draft1_Architecture_Overview.md` and `docs/V1_Implementation_Plan.md` already deferred, and the 8 new improvements from this request — and flags where they overlap, conflict, or depend on each other. Nothing here is a build plan yet. Review it, answer the open questions at the end, and I'll turn the result into a real task-by-task plan like the v1 one.

---

## What v1 already set up for v2 (no new work needed to unlock this)

- `StudySession.accountabilityGroupId` / `accountabilityUserIds` already exist on the type, unused — v2's social features slot values into fields that already exist rather than needing a schema migration.
- The domain/infrastructure/presentation layering means backend and social features are additive: nothing in v1's domain layer needs to change shape to support them.
- **`IndexedDbSessionRepository` (session history + event log) is already fully built and tested** (v1 Task 10) — this was originally slated for the arch overview's *Long-term* phase but got pulled into v1 because the storage layer needed it anyway. This matters directly for one of the new asks below (Analytics & Session History Visibility): the data already exists, only the UI to browse it doesn't.
- `chrome.idle` permission is already requested in the v1 manifest (Task 1) but **nothing in v1 actually calls the `chrome.idle` API** — this matters directly for another new ask below (Activity Status Tracker).

---

## Group A — Carried over from the v1 arch overview (unchanged scope)

These were always planned for v2; nothing here is new. Listed for completeness so the full picture is in one place.

**Accountability product phase:**
- Friend groups, invite codes
- Live session status (delivered by polling Supabase on a `chrome.alarms` cadence, per the arch overview's Friend-event delivery decision — not push, at least not initially)
- Predefined nudges
- Per-friend nudge settings and rate limits (send/receive toggles per friendship, independent cooldown from the pressure profile's session-wide cap)
- Daily accountability digest ("Bob was really locked in today")
- Unlock requests (a friend remotely approves an unlock — distinct from the **local** hard-block passcode v1 already built; these are two different unlock mechanisms that will coexist)
- Pressure escalation (already partly built in v1 as `interventionLevel`; this phase is about the *social* escalation — friends getting notified)
- Privacy controls (per-field visibility: goal text, time remaining, distraction attempts, etc.)
- Notification preferences

**Long-term product phase:**
- Analytics dashboard
- Offline sync
- Multiple devices (including passive companion use — an iPad open beside a laptop with no input shouldn't read as distraction)
- FCM push notifications for friend nudges (the Phase 2 upgrade from polling, conditional on polling latency actually becoming a problem)
- Email or SMS as optional notification integrations
- Bunny Land study groups
- Co-working rooms
- Additional Snuffles personalities (beyond the 6 already seeded in v1)
- Play Mode expansion (mini-games, cosmetics)
- Cross-browser support

---

## Group B — New improvements from this request

### 1. Onboarding & Welcome Experience

**What's asked:** an initial welcome screen explaining SnuffleStudy's purpose, naming Snuffles, and setting the hard-block passcode — all during first run.

**How it lands on v1:** v1's `OnboardingWizard` (Task 16) already has a multi-step flow, but it starts cold ("Meet Snuffles" as step one, no purpose framing) and **deliberately excludes passcode setup** — v1's plan put that in Settings on purpose, reasoning that the arch overview's own onboarding step list never mentioned a passcode step. This request reverses that call. That's fine, but worth naming explicitly: it's a deliberate v1 decision being overridden, not a bug being fixed.

**What's new:** a welcome/purpose screen before the existing steps, and moving passcode setup from Settings into onboarding (as an optional step — a user without a hard-block friend yet shouldn't be blocked from finishing onboarding).

**Dependencies:** none. Pure extension of an existing component.

---

### 2. Activity Status Tracker Settings

**What's asked:** a toggle to turn the activity tracker off, plus (implicitly, from the "Current Fix Context") actually wiring up real idle detection for the activity-only tier.

**Honest state of v1:** the "Current Fix Context" you flagged is accurate — I should say this plainly rather than gloss over it. In v1, the activity-only tier is a settings value that gates *permissions* (no host permission requested) but has **no behavior behind it**. `pageActivity.ts`'s `onUserActivity()` helper exists and is tested in isolation, but it's never called from anywhere — not the content script, not the background service worker. Nothing currently detects idle state. The `idle` permission is requested in the manifest but `chrome.idle` is never called. Activity-only mode today does nothing except avoid asking for site permissions.

**What v2 needs to decide:** what "idle" should actually *do* once detected — pause the session automatically? Just log it as a data point? Show a "still there?" check-in? — and whether the requested toggle is a **new tri-state** (`"none" | "activity-only" | "detailed"`) or a sub-toggle inside activity-only mode that keeps the tier binary. This needs a decision before it can be planned; see open questions below.

**Dependencies:** none technically (the `idle` permission already exists) — this is a design decision plus wiring work, not new infrastructure.

---

### 3. Analytics & Session History Visibility

**What's asked:** a History/Review screen in the popup, side panel, or options tab to browse past sessions and distraction logs, replacing the current DevTools-only path.

**How it lands on v1:** this is the cheapest item on the whole list. `IndexedDbSessionRepository.listHistory()` and `.listEvents()` (v1 Task 10) already do exactly the query work this screen needs — `HistoryQuery` already supports `limit`, `since`, and `state` filters. This is pure presentation-layer work: a new UI surface plus the `SESSION_LIST_HISTORY` / `SESSION_LIST_EVENTS`-style messages to expose those repository methods over the message bus (v1's `messageRouter.ts` doesn't currently expose them — only `SESSION_GET_ACTIVE` reads back active-session state).

**Overlap to resolve:** this is functionally a subset of the arch overview's existing **Analytics dashboard** item (Group A, Long-term). Worth deciding now whether "History/Review screen" *is* v2's Analytics dashboard (a browsable log, not charts/trends) or a smaller first pass with a separate, later Analytics dashboard doing aggregation/trends on top. See open questions.

**Dependencies:** none. Ships independent of the backend.

---

### 4. Dynamic Coach Coaching Messages (Restricted Sites)

**What's asked:** replace (or augment) the static warning-message pools with AI-generated, personalized callouts referencing the actual session goal — the example given, "That is not finishing Chapter 6 of STAT231," requires knowing the goal text and generating a line that references it specifically.

**How it lands on v1:** v1 built `pickWarningMessage()` (Task 7) as a pure, offline, zero-latency function picking randomly from a static pool per pressure profile. That system doesn't go away — it becomes the **fallback path**: offline, API failure, or rate-limited requests should degrade to the existing static pool rather than showing nothing or blocking the warning UI on a network round trip.

**What's new and needs deciding:**
- An actual API call from a browser extension context. The API key **cannot** ship in the extension bundle (visible to anyone who unpacks it) — this needs a backend proxy, which means it depends on *some* backend existing, even a minimal one (could piggyback on the Supabase instance Group A stands up, or be a lightweight standalone proxy if this ships before Accountability infra).
- Latency: an LLM call takes real time; the warning UI (v1's `SnufflesOverlay`) currently renders synchronously off `classifySite()`. This needs a "show the static message immediately, swap in the generated one if it arrives before the user dismisses" pattern, not a blocking wait.
- Cost/rate limiting per session, since this fires on every distraction event.

**Dependencies:** a backend proxy (new, or borrowed from Group A's Supabase work).

---

### 5. Temporary Passcodes for Hard Mode

**What's asked:** when a hard-restricted site is hit, request a one-time temporary passcode from a designated accountability friend via email; the friend gives you the code to unlock just that site, not the whole hard-block.

**How it lands on v1:** v1's `HardBlockCredential` (Task 6) is a single, persistent, locally-stored passcode the user sets once and shares out-of-band (text, in person) — deliberately designed to need **zero backend**, which is why it shipped in v1's Core local product phase instead of waiting for Accountability. This new flow is a different shape entirely: **per-request, time-boxed, site-scoped**, and requires knowing who the "designated accountability friend" is (a v1-nonexistent concept) and being able to email them.

**What's new:**
- A "designated accountability friend" concept — this is Friend groups (Group A) by another name; this feature cannot exist before Friend groups does.
- Outbound email sending — new infrastructure (a transactional email provider, e.g. Resend or Postmark, likely triggered from a Supabase Edge Function).
- A temporary-credential data model distinct from `HardBlockCredential` — scoped to one hostname, one expiry, one issuance.
- How the friend responds isn't specified — literally emailing back a code (highest friction, works for anyone), or a link the friend clicks (needs the friend to have an account/backend session), or — if the friend already has the extension installed — an in-app approval notification as a faster alternative to email. Worth deciding which of these v2 actually builds, since they're different amounts of work. See open questions.

**Dependencies:** Friend groups (Group A) must exist first. Email sending is new, standalone infrastructure.

---

### 6. Study Rooms

**What's asked:** virtual spaces where friends gather to study together, with built-in video calling.

**Overlap to resolve:** this is very likely the same concept as the arch overview's existing **"Co-working rooms"** and/or **"Bunny Land study groups"** items (Group A, Long-term) — just named and specified with more detail (video calling wasn't in the original one-line bullets). Worth confirming whether "Study Rooms" *replaces* those two bullets or is a third, related-but-distinct thing.

**What's new:** this is the single largest infrastructure item in this whole list. Nothing in either prior document anticipates real-time presence or video. It needs:
- A presence layer (who's currently "in" a room) — realtime, not polling; Supabase Realtime could carry this, consistent with the backend already planned.
- Video calling specifically — a build vs. buy decision between raw WebRTC (full control, full complexity, you build signaling/TURN/STUN infrastructure yourself) and a hosted SDK (Daily.co, LiveKit, Twilio Video, etc. — much faster to ship, ongoing per-minute cost, less control). This is a big enough decision that it probably deserves its own short spike/comparison before it goes into a task-by-task plan, not a default picked here.

**Dependencies:** Friend groups (to know who can join a room). Otherwise independent of everything else in this document.

---

### 7. "Producer Tags" (Audio Nudges)

**What's asked:** record short voice snippets, broadcast them to friends or into a Study Room as a low-effort nudge.

**What's new:** audio recording (`MediaRecorder` API — doable in an extension context, but recording UI and permission prompts need designing), audio storage (Supabase Storage is a natural fit given the backend choice), and a delivery path — "to friends" reuses the friend-event delivery mechanism Group A builds (polling → later push), "into a Study Room" depends on Study Rooms existing.

**Dependencies:** Friend groups and/or friend-event delivery (Group A) for the "to friends" path; Study Rooms (item 6) for the "into a room" path. This is downstream of both — it can't be first.

---

### 8. Task Vault & Session Breakdown

**What's asked:** a central to-do vault holding upcoming tasks; users pick a task from the vault and break it into actionable pieces for a session.

**How it lands on v1:** today, `StudySession.goal` is a single free-text string (v1 Task 2) — there's no persistent task list independent of a session, and no concept of breaking one task into sub-pieces. This is a genuinely new domain concept, not an extension of an existing one.

**What's new:** a `Task` (or similar) entity with its own storage (likely IndexedDB, alongside session history — no backend needed for a local-only vault), a breakdown/sub-task relationship, and a "start a session from this task" flow that pre-fills `SessionSetupForm`'s goal field from the selected (sub-)task.

**Nice synergy worth naming:** if this exists, item 4 (Dynamic Coaching Messages) gets meaningfully better raw material — "Chapter 6 of STAT231" reads like a structured task field, not a freeform goal string. Worth sequencing Task Vault before or alongside Dynamic Coaching Messages rather than after, if both are in scope for the same v2 window.

**Dependencies:** none for a local-only version. Syncing tasks across devices/friends would depend on the backend, but that's not what's being asked for here.

---

## Cross-cutting dependency map

```text
No backend needed at all:
  Onboarding & Welcome Experience
  Activity Status Tracker (chrome.idle wiring + toggle)
  Analytics & Session History Visibility (History/Review screen)
  Task Vault & Session Breakdown (local-only)

Backend foundation (unlocks almost everything else):
  Friend groups, invite codes, accountability permissions  [Group A]
  Live session status, predefined nudges, per-friend settings  [Group A]
  Unlock requests, daily digest, privacy controls  [Group A]
      |
      ├── depends on it: Temporary Passcodes for Hard Mode (+ new: email sending)
      ├── depends on it: Study Rooms (+ new: presence, video SDK decision)
      │         |
      │         └── depends on it: Producer Tags ("into a Study Room" path)
      └── depends on it: Producer Tags ("to friends" path)

Needs a backend proxy specifically (lighter than full Accountability infra):
  Dynamic Coach Coaching Messages (+ new: LLM API integration, latency handling)
```

The four no-backend items are all independent of each other and of everything else — they could genuinely ship first, fastest, with the least new infrastructure. Everything else funnels through "stand up the backend" as a hard prerequisite, then splits into three separately-sized efforts (temp passcodes + email, Study Rooms + video, coaching messages + LLM proxy) that don't block each other once the backend exists.

---

## Open questions before I write the full plan

1. **Analytics dashboard vs. History/Review screen** — same feature (a browsable log, nothing more, for now), or two tiers where History/Review ships first and a separate aggregate/trends Analytics dashboard comes later?
2. **Co-working rooms / Bunny Land study groups vs. Study Rooms** — does "Study Rooms" replace those two arch-overview bullets outright, or is it a distinct third thing?
3. **Activity-only tracking** — new tri-state tracking tier (`none` / `activity-only` / `detailed`), or a sub-toggle inside the existing activity-only tier? And once idle is detected, what should actually happen — auto-pause, a check-in prompt, or just a logged data point?
4. **Temporary passcode delivery** — strictly email (works for any friend, highest friction), or also an in-app notification path when the friend already has the extension (faster, but only works friend-to-friend within the product)?
5. **Dynamic coaching messages** — which model/API, and confirm the static per-profile message pool stays as the offline/failure fallback rather than being replaced outright?
6. **Study Rooms video** — build on raw WebRTC or a hosted SDK (Daily.co / LiveKit / Twilio)? This is a real cost and complexity tradeoff worth deciding deliberately, not defaulting into.
7. **Sequencing** — does the no-backend group (items 1–3 above, plus Task Vault) ship as an early, fast v2.0 slice before the backend-dependent group even starts, or do you want everything planned as one combined v2?

Answer what you can, and I'll fold the decisions into the full implementation plan.
