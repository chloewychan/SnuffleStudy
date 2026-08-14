# SnuffleStudy V2 Implementation Plan

**Goal:** Add the Accountability layer (friend groups, live status, nudges, unlock requests, daily digest) plus eight new improvements — onboarding refinement, real activity tracking, a local history browser, AI-generated coaching messages, temporary hard-block passcodes, Study Rooms with video, Producer Tags, and a Task Vault — on top of the local-only v1 engine, without touching v1's domain layer shape.

**Architecture:** Same layering as v1 (domain / infrastructure / presentation, typed messaging). This version adds one new infrastructure family — `src/infrastructure/backend/` — as the only thing allowed to talk to Supabase, plus two new capability wrappers (`infrastructure/audio/`, `infrastructure/video/`) for Producer Tags and Study Rooms. Nothing in v1's `domain/session`, `domain/sites`, or `domain/pressure` changes shape; v2 only adds new domain folders (`domain/accountability`, `domain/tasks`, `domain/coaching`, `domain/rooms`) and extends `SessionEventType` and `UserSettings` with new variants/fields.

**Tech Stack additions over v1:** Supabase (Postgres + Auth + Realtime + Edge Functions + Storage), Resend (transactional email), Anthropic Claude API (called only from a Supabase Edge Function, never from the extension directly), LiveKit (video calling — see Decision 6).

Unlike `docs/V1_Implementation_Plan.md`, this plan does not write out full TDD code for every task. That's a deliberate, selective choice, not a uniform reduction in rigor — detail is weighted by how well-understood the work is, not by which version it's in:

- **Full type/schema/interface precision** where a mistake would cause cross-task integration bugs or a security defect: exact Supabase column types (Task 5), exact message and function signatures shared across tasks (`Interfaces` block on every task below), exact security guarantees for anything touching RLS or secrets.
- **Goal/deliverable/definition-of-done, no exact call syntax** for fast-moving third-party SDKs (LiveKit, Resend, the Anthropic API, Supabase's own client library) — writing exact API calls from memory risks encoding stale or wrong syntax that a faithful executor won't question. These tasks specify the contract (inputs, outputs, error behavior, where secrets live) and expect the implementer to confirm exact syntax against current docs at build time.
- **Same level as v1** for anything local-only and deterministic (Phase 1) — this is the same kind of work v1 already did in full, just smaller in scope, so goal/deliverable/DoD without full TDD is a reasonable proportional level, not a corner cut.

Each task still names concrete files and a concrete definition of done.

## Execution instructions

- **Use a git branch for this work, not a worktree.** Create a `v2` branch off `main` and work on it directly (or a short-lived branch per phase, merged back to `v2` as phases complete). Do not set up a separate worktree for this plan.
- **Do not stop for sanity-check review after each task.** Work through the task list in order without pausing for user confirmation between tasks. Still run each task's own test/build verification as part of finishing that task — "no pausing for sanity checks" means no stopping to ask the user for sign-off task-by-task, not skipping automated verification. Only stop early if a task is genuinely blocked (a decision below turns out to be wrong, a dependency isn't actually available) or a phase is complete.

## Global Constraints

Everything from `docs/V1_Implementation_Plan.md`'s Global Constraints still applies unchanged (timestamp-based timers, no certainty claims about distraction, the hard-block kill-switch rule, no broad permissions without opt-in, required `staticFrame` per animation state). New constraints for v2:

- No API key (Anthropic, Resend, LiveKit) ever ships inside the extension bundle. Every third-party API call the extension needs goes through a Supabase Edge Function that holds the secret server-side.
- Friend-visible data stays field-gated per the arch overview's privacy controls (`docs/Draft1_Architecture_Overview.md` — Friend accountability): default to minimal visibility, enforced with Postgres Row Level Security, not just client-side filtering.
- A temporary hard-block passcode (new in v2) unlocks exactly the one hostname it was issued for, for a bounded time. It never disables hard mode generally and never substitutes for the persistent `HardBlockCredential` from v1 — the two coexist as separate unlock paths.
- Anything that depends on the backend (Phase 2 onward) must degrade gracefully offline, consistent with v1's offline-first requirement — a friend group feature failing to sync should never block starting or running a local session.

---

## Decisions

The `docs/V2_Scope_Summary.md` review round ended with seven open questions. Rather than block the plan on them, here are the calls made to write this plan — flagged clearly so you can override any of them before or during execution.

1. **Analytics dashboard vs. History/Review screen:** building the History/Review screen only (a filterable browser over v1's already-built `IndexedDbSessionRepository` data). The aggregate/trends Analytics dashboard from the arch overview's Long-term phase stays deferred past v2 — building charts before seeing what real session data looks like is premature.
2. **Co-working rooms / Bunny Land study groups vs. Study Rooms:** "Study Rooms" is the concrete realization of both arch-overview bullets. This plan retires the vaguer wording; there is one feature, not three.
3. **Activity-only tracking:** not a new tri-state tier. `UserSettings.trackingTier` stays `"activity-only" | "detailed"`; a new `activityTrackingEnabled: boolean` (default `true`) gates whether `chrome.idle` wiring runs at all while in activity-only mode. Detected idle transitions are recorded as `SessionEvent`s (new types `USER_WENT_IDLE` / `USER_RETURNED_FROM_IDLE`), not auto-paused — auto-pausing removes user agency and repeats the "claims to know if you're really studying" mistake the product already avoids.
4. **Temporary passcode delivery:** one request flow, two delivery paths, not two features. Every request emails the designated friend (works regardless of whether they use SnuffleStudy). If the friend also has a SnuffleStudy account, the same request additionally lands as an in-app approval — friend-event delivery (Phase 2) already carries this, so it's nearly free once Phase 2 exists.
5. **Dynamic coaching messages:** Anthropic's Claude API, called from a Supabase Edge Function. v1's static per-profile message pool (`pickWarningMessage`) stays as the fallback for offline, API failure, or rate-limiting — never replaced outright.
6. **Study Rooms video:** a hosted SDK, not raw WebRTC — **LiveKit** specifically (open-source core, a usable free tier on LiveKit Cloud, first-class browser SDK). Raw WebRTC means building your own signaling and TURN/STUN infrastructure, which isn't a good time investment relative to a hosted option for a project this size. Swap this pick if you have a reason to prefer Daily.co or Twilio Video — the integration point (`infrastructure/video/videoCallClient.ts`) is isolated specifically so that swap doesn't ripple.
7. **Sequencing:** yes — the no-backend group ships first as an early, fast slice (Phase 1), then the backend foundation (Phase 2), then the three backend-dependent tracks (Phase 3), which can run loosely in parallel once Phase 2 lands since they don't depend on each other.

---

## Scope for v2

**In scope** (all eight new improvements, plus the arch overview's full Accountability product phase):

- Onboarding & Welcome Experience refinement
- Activity Status Tracker wiring + toggle
- History/Review screen
- Task Vault & Session Breakdown
- Friend groups, invite codes, accountability permissions
- Live session status sync, predefined nudges, per-friend nudge settings and rate limits
- Unlock requests, daily accountability digest, privacy controls, notification preferences
- Dynamic Coach Coaching Messages
- Temporary Passcodes for Hard Mode
- Study Rooms (presence + video)
- Producer Tags (audio nudges)

**Still explicitly out of scope, deferred past v2** (unchanged from the arch overview's Long-term phase, minus what v2 just absorbed):

- FCM push notifications (the Phase 2-of-nudge-delivery upgrade from polling — stays conditional on polling latency actually becoming a problem)
- Offline sync of backend data beyond "don't break when offline" (full conflict resolution across devices)
- Multiple-device support
- Cross-browser support
- Play Mode expansion (mini-games, cosmetics)
- Additional Snuffles personalities beyond the 6 seeded in v1
- Aggregate Analytics dashboard (charts/trends layered on top of the History/Review screen's raw data)
- Real hand-drawn animation frames and Figma-sourced visual design (still placeholders — unrelated to this version's scope)

---

## New file structure (additions over v1)

```text
src/
├── domain/
│   ├── session/
│   │   └── sessionTypes.ts          (extend: SessionEventType += USER_WENT_IDLE, USER_RETURNED_FROM_IDLE)
│   ├── settings/
│   │   └── userSettings.ts          (extend: + activityTrackingEnabled: boolean)
│   ├── accountability/
│   │   ├── friendGroup.ts           (FriendGroup, GroupMembership, InviteCode)
│   │   ├── friendshipSettings.ts    (FriendshipSettings — same shape already named in the arch overview)
│   │   ├── friendEvent.ts           (FriendEvent — the minimal event shape friends receive, per arch overview's privacy example)
│   │   ├── unlockRequest.ts         (UnlockRequest)
│   │   └── tempPasscodeRequest.ts   (TempPasscodeRequest)
│   ├── tasks/
│   │   └── taskTypes.ts             (Task, TaskBreakdownItem)
│   ├── coaching/
│   │   └── coachingMessageRequest.ts (CoachingMessageRequest/Response shapes)
│   └── rooms/
│       ├── studyRoom.ts             (StudyRoom, RoomParticipant)
│       └── producerTag.ts           (ProducerTag)
│
├── infrastructure/
│   ├── backend/
│   │   ├── supabaseClient.ts        (single configured client, auth session handling)
│   │   ├── friendGroupApi.ts
│   │   ├── sessionStatusSyncApi.ts
│   │   ├── nudgeApi.ts
│   │   ├── unlockRequestApi.ts
│   │   ├── digestApi.ts
│   │   ├── tempPasscodeApi.ts
│   │   ├── coachingApi.ts
│   │   ├── studyRoomApi.ts
│   │   └── producerTagApi.ts
│   ├── storage/
│   │   └── taskRepository.ts        (IndexedDB, local Task Vault — no backend dependency)
│   ├── idle/
│   │   └── idleApi.ts               (chrome.idle wrapper)
│   ├── audio/
│   │   └── audioRecorder.ts         (MediaRecorder wrapper for Producer Tags)
│   └── video/
│       └── videoCallClient.ts       (LiveKit wrapper — isolated per Decision 6)
│
├── app/routes/
│   ├── WelcomeScreen.tsx            (new first onboarding step)
│   └── TaskVaultPage.tsx
├── options/pages/
│   └── HistoryPage.tsx
├── sidepanel/components/
│   ├── FriendGroupPanel.tsx
│   ├── UnlockRequestPanel.tsx
│   └── StudyRoomPanel.tsx
│
supabase/
├── migrations/                       (schema, see Task 6)
└── functions/
    ├── generate-coaching-message/
    └── send-temp-passcode-request/
```

Everything under `src/domain/`, `src/infrastructure/`, and `src/shared/` from v1 stays exactly where it is — v2 only adds new siblings, it doesn't move or rename anything that already shipped.

---

## Build order

**Phase 1 — No-backend slice.** Ships fastest, de-risks nothing else, unlocks nothing else. Independent of Phase 2 entirely.
1. Onboarding & Welcome Experience
2. Activity Status Tracker
3. History/Review screen
4. Task Vault & Session Breakdown

**Phase 2 — Backend foundation.** Everything past this point depends on it existing.
5. Supabase project setup, schema, and auth
6. Friend groups, invite codes, accountability permissions
7. Live session status sync
8. Predefined nudges, per-friend nudge settings and rate limits
9. Unlock requests
10. Daily accountability digest
11. Privacy controls and notification preferences

**Phase 3 — Backend-dependent new features.** These three tracks don't depend on each other, only on Phase 2. They can be built in any order or in parallel.
- Track A: 12. Dynamic Coach Coaching Messages
- Track B: 13. Temporary Passcodes for Hard Mode
- Track C: 14. Study Rooms → 15. Producer Tags (Producer Tags depends on Study Rooms existing for the "into a room" delivery path, and on Phase 2's friend-event delivery for the "to a friend" path — so it's the one task in Phase 3 with an in-phase dependency)

**Phase 4 — Verification.**
16. Full regression pass against v1's Definition of a quality first release + a new v2 QA checklist

---

## Tasks

### Task 1: Onboarding & Welcome Experience

**Goal:** Add a purpose-framing welcome screen before v1's existing onboarding steps, and move hard-block passcode setup into onboarding as an optional step (overriding v1's original "passcode lives only in Settings" call).

**Depends on:** nothing (extends v1 `OnboardingWizard`, Task 16).

**Interfaces:**
- Consumes: `OnboardingWizard`'s `Step` union and `finish()` (v1 Task 16), `HARD_BLOCK_SET_PASSCODE` message (v1 Task 11), `PRESSURE_PROFILES` (v1 Task 7).
- Produces: `Step` extended with `"passcode"`; `<WelcomeScreen />` shown before step `"name"`. Nothing here is consumed by a later v2 task.

**Deliverables:**
- `WelcomeScreen.tsx` — one static screen explaining the product's purpose ("consensual peer pressure," not a generic timer), shown before `OnboardingWizard`'s existing "name" step.
- Extend `OnboardingWizard`'s step union with a new optional `"passcode"` step, inserted after `"tracking"` (or after `"sites"` if detailed tracking was chosen) — reuses v1's `HARD_BLOCK_SET_PASSCODE` message and the passcode-strength rule already in `OptionsApp`. Must be skippable — a user without anyone to share the passcode with yet shouldn't be blocked from finishing onboarding.

**Definition of done:** a fresh install shows the welcome screen first; a user can set a passcode during onboarding and skip it; skipping doesn't block completion; `Settings → Hard-block passcode` still works standalone for users who skip and set one later.

---

### Task 2: Activity Status Tracker

**Goal:** Give the activity-only tracking tier actual behavior (it currently has none, per Decision 3 in `docs/V2_Scope_Summary.md`), and let users turn it off.

**Depends on:** nothing (wires up `chrome.idle`, already a granted permission since v1).

**Interfaces:**
- Consumes: `UserSettings` (v1 Task 9), `SessionEventType` and `IndexedDbSessionRepository.recordEvent` (v1 Task 10), the `idle` permission already declared in the manifest (v1 Task 1).
- Produces: `UserSettings.activityTrackingEnabled: boolean`; `SessionEventType` gains `"USER_WENT_IDLE" | "USER_RETURNED_FROM_IDLE"`; `idleApi.ts` exports `startIdleMonitoring(intervalSeconds: number, onStateChange: (state: "active" | "idle" | "locked") => void): void` and `stopIdleMonitoring(): void`. Task 3 consumes the two new event types to render them in history.

**Deliverables:**
- `infrastructure/idle/idleApi.ts` — thin wrapper around `chrome.idle.setDetectionInterval` / `chrome.idle.onStateChanged`.
- Extend `UserSettings` with `activityTrackingEnabled: boolean` (default `true`).
- Extend `SessionEventType` with `USER_WENT_IDLE` and `USER_RETURNED_FROM_IDLE`.
- Background wiring: while `trackingTier === "activity-only"`, `activityTrackingEnabled === true`, and a session is `FOCUSING`, subscribe to `chrome.idle.onStateChanged` and record the two new event types via `IndexedDbSessionRepository.recordEvent`. No content script needed — `chrome.idle` is OS-level, not page-level, so this doesn't need or request any host permission.
- New toggle in `OptionsApp` under the existing Tracking section.

**Definition of done:** with activity-only tracking on and the toggle enabled, going idle for the configured interval (test with a short interval, e.g. 15 seconds) records a `USER_WENT_IDLE` event, visible via the History/Review screen (Task 3) once that exists; turning the toggle off stops new events without touching existing history.

---

### Task 3: History/Review screen

**Goal:** Replace the DevTools-only path to session/event data with a real UI screen.

**Depends on:** nothing new — `IndexedDbSessionRepository.listHistory()` / `.listEvents()` already exist and do the query work (v1 Task 10).

**Interfaces:**
- Consumes: `HistoryQuery`, `SessionEvent` (v1 Task 2), `IndexedDbSessionRepository.listHistory`/`.listEvents` (v1 Task 10), the two new event types from Task 2.
- Produces: `ExtensionMessage` gains `{ type: "SESSION_LIST_HISTORY"; payload: HistoryQuery }` and `{ type: "SESSION_LIST_EVENTS"; payload: { sessionId: string } }`.

**Deliverables:**
- New messages: `SESSION_LIST_HISTORY` (payload: `HistoryQuery`), `SESSION_LIST_EVENTS` (payload: `{ sessionId: string }`) added to `shared/messages.ts` and handled in `messageRouter.ts` by calling the existing repository methods directly — no new domain logic required.
- `options/pages/HistoryPage.tsx` — a filterable list (by date range, completed/abandoned) of past sessions, expandable to show that session's event log (distraction attempts, recoveries, idle transitions from Task 2).

**Definition of done:** every session run since install (including ones from v1 testing, if the extension wasn't reinstalled) is browsable without opening DevTools; filtering by state and date range works; selecting a session shows its event timeline.

---

### Task 4: Task Vault & Session Breakdown

**Goal:** A persistent, local task list independent of any single session, with the ability to break a task into sub-pieces and start a session pre-filled from one.

**Depends on:** nothing (local-only, no backend).

**Interfaces:**
- Consumes: `SessionSetupForm` (v1 Task 17), `StudySession` (v1 Task 2), the `SESSION_END` handling in `messageRouter.ts` (v1 Task 13).
- Produces: `Task`, `TaskBreakdownItem` (below); `TaskRepository` interface with `create(task)`, `update(task)`, `delete(taskId)`, `list()`, `addBreakdownItem(taskId, description)`; `ExtensionMessage` gains `TASK_CREATE`, `TASK_UPDATE`, `TASK_DELETE`, `TASK_LIST`, `TASK_ADD_BREAKDOWN_ITEM`; `StudySession.taskBreakdownItemId?: string`. Task 11 (coaching messages) can optionally consume `TaskBreakdownItem.description` as richer prompt input than a freeform goal string, if built after this task.

**Deliverables:**
- `domain/tasks/taskTypes.ts`:
  ```ts
  interface Task {
    id: string;
    title: string;
    createdAt: number;
    completedAt?: number;
    breakdown: TaskBreakdownItem[];
  }
  interface TaskBreakdownItem {
    id: string;
    description: string;   // e.g. "Chapter 6 of STAT231"
    completedAt?: number;
  }
  ```
- `infrastructure/storage/taskRepository.ts` — new IndexedDB object store (`tasks`), same `idb`-based pattern as `indexedDbRepository.ts`.
- New messages: `TASK_CREATE`, `TASK_UPDATE`, `TASK_DELETE`, `TASK_LIST`, `TASK_ADD_BREAKDOWN_ITEM`.
- `app/routes/TaskVaultPage.tsx` — list tasks, add/edit breakdown items, and a "Start a session from this" action per breakdown item that pre-fills `SessionSetupForm.goal` with the item's `description` and passes the `taskId`/breakdown item id through so the session can be linked back (extend `StudySession` with an optional `taskBreakdownItemId?: string`).

**Definition of done:** a task with multiple breakdown items can be created, a session started from a specific item shows that item's description as the goal, and completing that session marks the breakdown item's `completedAt` (via a new `SESSION_END` side effect in `messageRouter.ts` when `taskBreakdownItemId` is present).

---

### Task 5: Supabase project setup, schema, and auth

**Goal:** Stand up the backend everything else in Phase 2/3 depends on.

**Depends on:** nothing (first backend task).

**Interfaces:**
- Produces: `supabaseClient.ts` exported client; the full schema below (every later Phase 2/3 task builds against these exact tables/columns — do not let individual tasks improvise column names or types); `friendGroupApi.ts` with `createGroup(name)`, `generateInviteCode(groupId)`, `joinGroup(code)`, `listMembers(groupId)`.

**Deliverables:**
- A Supabase project, `infrastructure/backend/supabaseClient.ts` (env-configured client), and Supabase Auth wired into the extension (sign-in flow — email/magic-link is the simplest fit for a browser extension, avoiding OAuth-in-a-popup complexity).
- Full schema (`supabase/migrations/`), typed exactly so later tasks don't each guess independently:

  ```text
  friend_groups
    id             uuid primary key
    name           text not null
    owner_user_id  uuid not null references auth.users(id)
    created_at     timestamptz not null default now()

  group_memberships
    group_id   uuid not null references friend_groups(id)
    user_id    uuid not null references auth.users(id)
    joined_at  timestamptz not null default now()
    primary key (group_id, user_id)

  invite_codes
    code        text primary key
    group_id    uuid not null references friend_groups(id)
    created_by  uuid not null references auth.users(id)
    expires_at  timestamptz not null
    used_by     uuid references auth.users(id)

  friendship_settings
    user_id                 uuid not null references auth.users(id)
    friend_user_id          uuid not null references auth.users(id)
    receive_live_nudges     boolean not null default true
    send_live_nudges        boolean not null default true
    receive_daily_digest    boolean not null default true
    nudge_cooldown_seconds  integer not null default 300
    primary key (user_id, friend_user_id)

  session_status_events
    id             uuid primary key
    user_id        uuid not null references auth.users(id)
    session_id     text not null    -- matches StudySession.id (client-generated, NOT a DB uuid)
    type           text not null    -- SessionEventType-shaped, e.g. "SESSION_STARTED"
    display_label  text not null    -- never the raw hostname unless the sender explicitly opted in
    occurred_at    timestamptz not null

  unlock_requests
    id                  uuid primary key
    session_id          text not null
    requester_user_id   uuid not null references auth.users(id)
    hostname            text not null
    status              text not null   -- 'pending' | 'approved' | 'denied'
    requested_at        timestamptz not null default now()
    resolved_at         timestamptz
    resolved_by         uuid references auth.users(id)

  temp_passcode_requests
    id                  uuid primary key
    session_id          text not null
    hostname            text not null
    requester_user_id   uuid not null references auth.users(id)
    friend_user_id      uuid not null references auth.users(id)
    status              text not null   -- 'pending' | 'approved' | 'denied' | 'expired'
    code_hash           text not null
    expires_at          timestamptz not null
    delivered_via       text not null   -- 'email' | 'email+in_app'

  study_rooms
    id             uuid primary key
    name           text not null
    owner_user_id  uuid not null references auth.users(id)
    created_at     timestamptz not null default now()

  study_room_participants
    room_id    uuid not null references study_rooms(id)
    user_id    uuid not null references auth.users(id)
    joined_at  timestamptz not null default now()
    left_at    timestamptz
    primary key (room_id, user_id, joined_at)

  producer_tags
    id           uuid primary key
    user_id      uuid not null references auth.users(id)
    audio_url    text not null
    duration_ms  integer not null
    created_at   timestamptz not null default now()

  producer_tag_sends
    tag_id              uuid not null references producer_tags(id)
    sender_user_id      uuid not null references auth.users(id)
    recipient_user_id   uuid references auth.users(id)       -- null if sent to a room
    recipient_room_id    uuid references study_rooms(id)      -- null if sent to a friend
    sent_at             timestamptz not null default now()
  ```

- Row Level Security on every table above — this is the enforcement mechanism, not client-side filtering, per the Global Constraints above. Exact policy SQL is an implementation detail to write against current Supabase syntax, but each table's policy must satisfy a specific, testable guarantee:
  - `friend_groups` / `group_memberships`: a user can read a group's rows only if they're a member (row exists in `group_memberships` for their `user_id`).
  - `invite_codes`: a user can read/use a code only if `expires_at` is in the future and `used_by` is null; writing `used_by` is only valid once.
  - `friendship_settings`: a user can read/write only rows where `user_id = auth.uid()`; a user can never read or modify the `friendship_settings` row where they are the `friend_user_id` (that's the *other* person's control over the relationship, not theirs).
  - `session_status_events`: a user can read another user's event only if that other user has a `group_memberships` row in common with them **and** the event's visibility (per `friendship_settings` / Task 10's field-level toggles) allows it — never just "same group" alone.
  - `unlock_requests` / `temp_passcode_requests`: readable/writable only by the `requester_user_id` or the resolving friend (`resolved_by` / `friend_user_id`), no one else in the group.
  - `producer_tag_sends`: readable only by `sender_user_id`, `recipient_user_id`, or a member of `recipient_room_id`.
- `infrastructure/backend/friendGroupApi.ts` wrapping the group/invite-code/membership CRUD.

**Definition of done:** a user can sign in, create a group, generate an invite code, and a second test account can join via that code. For each RLS guarantee listed above, write an explicit negative test: authenticate as account B and attempt to read/write a row that guarantee says B shouldn't be able to touch (another user's `friendship_settings` row where B is `friend_user_id`, another group's `session_status_events`, a resolved `unlock_request` belonging to someone else) — the request must fail, not just return an empty/filtered result.

---

### Task 6: Live session status sync

**Goal:** A friend group sees session status events, delivered by polling per the arch overview's Friend-event delivery decision — not push, not yet.

**Depends on:** Task 5.

**Interfaces:**
- Consumes: `session_status_events` table and `friendship_settings` (Task 5); v1's session lifecycle transition points in `messageRouter.ts` (v1 Task 13).
- Produces: `sessionStatusSyncApi.ts` with `recordStatusEvent(event: { type: SessionEventType; sessionId: string; displayLabel: string }): Promise<void>` and `fetchNewEventsForFriends(sinceTimestamp: number): Promise<FriendEvent[]>`; a `chrome.alarms` entry named `"snufflestudy-friend-poll"` (distinct from v1's `"snufflestudy-session-timer"` — the two must never collide or cancel each other). Tasks 7, 8, 9, and 14 all reuse this exact poll/notification path — "the same path as Task 6" in those tasks means calling `fetchNewEventsForFriends` and hooking into the same alarm, not building a parallel one.

**Deliverables:**
- `infrastructure/backend/sessionStatusSyncApi.ts` — writes `session_status_events` rows on session start/pause/resume/break/end/complete (reusing v1's existing lifecycle transitions in `messageRouter.ts` as the trigger points, gated by whether the user is in a group and has sync enabled).
- A `chrome.alarms`-driven poll (per the arch overview's Phase 1 delivery plan) that fetches new events for the user's friends and surfaces them as `chrome.notifications` — only runs the alarm while a session with friend features enabled is active, per the arch overview's stated battery/backend-load discipline.
- `sidepanel/components/FriendGroupPanel.tsx` — shows friends' current status (only fields each friendship's `friendship_settings` allows).

**Definition of done:** two test accounts in the same group; starting a session on one account produces a status event the other account's poll picks up within one alarm interval, respecting whatever visibility settings are configured.

---

### Task 7: Predefined nudges, per-friend settings, rate limits

**Goal:** Let friends send predefined nudges, gated by per-friendship send/receive toggles and a cooldown independent of the pressure profile's session-wide cap.

**Depends on:** Task 6.

**Interfaces:**
- Consumes: Task 6's poll/notification path and `session_status_events` shape; `friendship_settings` (Task 5).
- Produces: `nudgeApi.ts` with `sendNudge(friendUserId: string, messageId: string): Promise<{ ok: boolean; error?: string }>` — the cooldown/toggle rejection must happen server-side (return `ok: false` from a Postgres function or RLS check), never client-side-only.

**Deliverables:**
- `infrastructure/backend/nudgeApi.ts` — send/receive predefined nudge messages, enforcing `friendship_settings.receive_live_nudges` / `send_live_nudges` and `nudge_cooldown_seconds` server-side (RLS or a Postgres function — not client-side, since the sender's client can't be trusted to self-limit).
- UI: a nudge-send action in `FriendGroupPanel.tsx`, and incoming nudges rendered the same way v1's `SnufflesOverlay` warning renders (reuse that visual pattern, don't invent a new one).

**Definition of done:** a nudge sent from one account respects the recipient's toggle (blocked entirely if off) and the cooldown (a second nudge within the window is rejected server-side, not just hidden client-side).

---

### Task 8: Unlock requests

**Goal:** The remote, friend-approved unlock path from the arch overview — distinct from v1's local hard-block passcode.

**Depends on:** Task 6.

**Interfaces:**
- Consumes: `unlock_requests` table (Task 5), Task 6's poll/notification path, `StudySession.siteRestrictionOverrides` (v1 Task 2).
- Produces: `unlockRequestApi.ts` with `createRequest(sessionId, hostname): Promise<UnlockRequest>`, `resolveRequest(requestId, decision: "approved" | "denied"): Promise<void>`.

**Deliverables:**
- `infrastructure/backend/unlockRequestApi.ts` — create a request (session id, hostname, requester), notify the group (via the same poll/notification path as Task 6), approve/deny from a friend's client.
- `sidepanel/components/UnlockRequestPanel.tsx` — request UI on the requester's side, approve/deny UI on the friend's side.
- Wire an approved request into `messageRouter.ts`'s existing site-classification path so the requested hostname becomes temporarily allowed for that session (reuse the `siteRestrictionOverrides` mechanism from v1's `StudySession` rather than inventing a new override path).

**Definition of done:** a soft-restricted site, once an unlock request is approved by a friend, becomes accessible without a distraction warning for the rest of the session; a denied or unanswered request leaves the restriction in place.

---

### Task 9: Daily accountability digest

**Goal:** A once-a-day summary of a friend's session activity, per the arch overview's design (an alternative to live nudges, not a replacement).

**Depends on:** Task 6 (reuses the same `session_status_events` data).

**Interfaces:**
- Consumes: `session_status_events` (Task 5), `friendship_settings.receive_daily_digest` (Task 5).
- Produces: `digestApi.ts` with `fetchDigestForDate(date: string): Promise<DigestSummary[]>` where `DigestSummary` is `{ friendUserId, completedSessions, abandonedSessions, distractionCount, recoveryRate }`.

**Deliverables:**
- A scheduled Supabase Edge Function (daily) aggregating each user's completed/abandoned sessions, distraction counts, and recovery rate for friends who opted into `receive_daily_digest`.
- `infrastructure/backend/digestApi.ts` — fetch the day's digest for display.
- Digest surfaced as a `chrome.notifications` toast plus a card in `FriendGroupPanel.tsx` — "Bob was really locked in today," matching the arch overview's example copy.

**Definition of done:** a friend who opted into digests (and not live nudges) sees one summary per day, not per session; a friend who opted out sees nothing.

---

### Task 10: Privacy controls and notification preferences

**Goal:** The user-facing settings surface for everything Tasks 6–9 built.

**Depends on:** Tasks 6–9.

**Interfaces:**
- Consumes: `friendship_settings` (Task 5), `nudgeApi`/`digestApi` (Tasks 7, 9).
- Produces: no new types consumed downstream — this is a leaf UI task wiring existing settings to existing enforcement.

**Deliverables:**
- Extend `OptionsApp` with a Friends section: per-field visibility toggles (goal text, time remaining, distraction attempts, current domain, intervention count, full history) enforced by the RLS policies from Task 5, not just hidden in the UI.
- Notification preference toggles (live nudges on/off globally, digest on/off globally, quiet hours) layered on top of the per-friendship settings from Task 7.

**Definition of done:** every visibility/notification toggle added in Tasks 6–9 has a corresponding settings control. For each one, verify server-side, the same way as Task 5's RLS tests: toggle a field off, then attempt to read that field as the friend account — the read must fail or omit the field, not just be hidden by the UI. A toggle that only hides data in the UI without an RLS change behind it is not done.

This completes Phase 2. Everything below depends on it.

---

### Task 11: Dynamic Coach Coaching Messages

**Goal:** Personalized, AI-generated warning copy referencing the actual session goal, with v1's static message pool as the fallback.

**Depends on:** Task 5 (needs a Supabase Edge Function to hold the Anthropic API key).

**Interfaces:**
- Consumes: `pickWarningMessage()` and `PressureProfile` (v1 Task 7), `SnufflesOverlay` (v1 Task 20), optionally `TaskBreakdownItem.description` (Task 4) as richer prompt input than `StudySession.goal` alone.
- Produces: `coachingApi.ts` with `generateCoachingMessage(request: { pressureProfileId: string; goal: string; hostname: string; interventionLevel: InterventionLevel }): Promise<string>` — this function itself owns the timeout-and-fallback-to-`pickWarningMessage()` behavior, so `SnufflesOverlay` only ever calls one function and always gets a string back, synchronously-feeling or not.

**Deliverables:**
- `supabase/functions/generate-coaching-message/` — takes the same request shape as `coachingApi.ts` above, calls the Claude API server-side (API key held in the function's environment, never sent to the client), returns a short generated line matching the pressure profile's voice. Exact Anthropic SDK call syntax is intentionally not written here — confirm against current API docs at build time.
- `infrastructure/backend/coachingApi.ts` — calls the function, with a strict timeout (e.g. 800ms) after which the caller falls back to v1's `pickWarningMessage()`.
- Wire into `SnufflesOverlay`: render the static message immediately (zero perceived latency, matches v1's current behavior), swap in the generated line if it arrives before the user dismisses the warning — never block the warning UI on the network call.
- Basic per-user rate limiting in the Edge Function (this fires on every distraction event, so an unlimited loop is a real cost risk).

**Definition of done:** a distraction on a session with goal "Finish Chapter 6 of STAT231" produces a message referencing that goal specifically; going offline or exceeding the rate limit falls back to the static pool with no visible error to the user; confirm the Anthropic API key does not appear in `.output/` after a production build (same check as the Global Constraints secret rule, verified concretely here since this is the task that introduces the key).

---

### Task 12: Temporary Passcodes for Hard Mode

**Goal:** A per-request, time-boxed, single-hostname unlock via a designated friend — distinct from v1's persistent `HardBlockCredential`.

**Depends on:** Task 5 (friend groups) for knowing who the "designated friend" is; new email infrastructure.

**Interfaces:**
- Consumes: `temp_passcode_requests` table (Task 5), `hardBlockCredential.ts`'s hashing pattern (v1 Task 6), `LockedPage` (v1 Task 21), Task 6's poll path for the in-app delivery leg.
- Produces: `TempPasscodeRequest` (below); `tempPasscodeApi.ts` with `createRequest(sessionId, hostname, friendUserId): Promise<TempPasscodeRequest>`, `approveRequest(requestId): Promise<{ code: string }>` (plaintext code returned exactly once, to the approving friend, never stored), `redeemCode(requestId, code): Promise<{ ok: boolean }>`.

**Deliverables:**
- `domain/accountability/tempPasscodeRequest.ts`:
  ```ts
  interface TempPasscodeRequest {
    id: string;
    sessionId: string;
    hostname: string;
    friendUserId: string;
    status: "pending" | "approved" | "denied" | "expired";
    codeHash: string;
    expiresAt: number;
  }
  ```
- `supabase/functions/send-temp-passcode-request/` — sends the request email via Resend; if the designated friend has a SnuffleStudy account, also creates an in-app request the friend's client picks up through the same poll as Task 6/8 (per Decision 4 — one flow, two delivery paths).
- `infrastructure/backend/tempPasscodeApi.ts` — create request, friend approves (generating a short-lived code), requester enters the code on the existing `LockedPage` (Task 21 from v1) via a new "request a temporary passcode" action alongside the existing permanent-passcode entry field.
- Verification reuses v1's `hardBlockCredential.ts` hashing pattern (salted hash, never plaintext, rate-limited guesses) applied to the temporary code instead of the persistent one.

**Definition of done:** requesting a temp passcode for one hostname during a hard-mode session emails the designated friend (and notifies them in-app if they have an account); an approved code unlocks only that hostname, only until `expiresAt`, and every other hard-restricted site stays blocked; confirm `temp_passcode_requests.code_hash` is never queryable as, or reconstructible into, the plaintext code from the client (same hashing discipline as v1's `HardBlockCredential` — a temp code is not allowed to be a weaker link than the permanent one).

---

### Task 13: Study Rooms

**Goal:** Virtual spaces where friends gather to study together, with video calling via LiveKit (Decision 6).

**Depends on:** Task 5 (friend groups, to know who can join a room).

**Interfaces:**
- Consumes: `study_rooms` / `study_room_participants` tables (Task 5), `group_memberships` (Task 5) to gate who can join.
- Produces: `StudyRoom`, `RoomParticipant`; `studyRoomApi.ts` with `createRoom(name)`, `joinRoom(roomId)`, `leaveRoom(roomId)`, `subscribeToPresence(roomId, onChange)`; `videoCallClient.ts` with `joinCall(roomId: string, token: string): Promise<void>` and `leaveCall(): void` — this is the one file any future video-provider swap touches, so keep every LiveKit-specific type/import contained to it. Task 14 consumes `subscribeToPresence` and the room id shape.

**Deliverables:**
- `domain/rooms/studyRoom.ts` (`StudyRoom`, `RoomParticipant`), backing `study_rooms` / `study_room_participants` tables (schema addition to Task 5's migrations).
- `infrastructure/backend/studyRoomApi.ts` — create/join/leave a room, presence via Supabase Realtime (who's currently in the room).
- `infrastructure/video/videoCallClient.ts` — LiveKit room-join wrapper, isolated specifically so swapping providers later doesn't touch anything outside this one file.
- `sidepanel/components/StudyRoomPanel.tsx` — room list, join/create, embedded video grid.

**Definition of done:** two test accounts in the same friend group can create/join the same room and see/hear each other over video; leaving a room updates presence for the remaining participant within a few seconds.

---

### Task 14: Producer Tags (Audio Nudges)

**Goal:** Short recorded voice snippets, sent to a friend or broadcast into a Study Room.

**Depends on:** Task 13 (for the "into a room" delivery path) and Task 6/7's friend-event delivery (for the "to a friend" path) — the one task in Phase 3 with an in-phase dependency, so sequence it after Study Rooms.

**Interfaces:**
- Consumes: `producer_tags` / `producer_tag_sends` tables (Task 5), Task 6's poll/notification path, Task 13's `subscribeToPresence`/room id shape.
- Produces: `ProducerTag`; `audioRecorder.ts` with `startRecording(): void` and `stopRecording(): Promise<Blob>` (enforce the max-length cap inside `stopRecording`, not just in the UI); `producerTagApi.ts` with `uploadTag(blob: Blob): Promise<ProducerTag>`, `sendToFriend(tagId, friendUserId)`, `sendToRoom(tagId, roomId)`.

**Deliverables:**
- `domain/rooms/producerTag.ts` (`ProducerTag`), backing `producer_tags` / `producer_tag_sends` tables.
- `infrastructure/audio/audioRecorder.ts` — `MediaRecorder`-based short-clip recording with an explicit permission prompt (browser mic access, separate from any extension permission).
- Storage via Supabase Storage (audio files), `infrastructure/backend/producerTagApi.ts` for upload/send.
- Delivery reuses Task 6's poll/notification path for friend-to-friend, and Task 13's Realtime presence channel for room broadcasts.
- Minimal recording/playback UI, placed in both `FriendGroupPanel.tsx` and `StudyRoomPanel.tsx`.

**Definition of done:** a recorded tag can be sent to a specific friend (arrives via the same delivery path as a nudge) or broadcast into an active Study Room (all current participants hear it); clips have an enforced max length (e.g. 10 seconds) so this can't become a full voice-messaging feature by accident.

This completes Phase 3.

---

### Task 15: Full regression pass and v2 QA checklist

**Goal:** Confirm v1's behavior still holds and every v2 feature works end-to-end together, not just in isolation.

**Depends on:** all prior tasks.

- [ ] Run v1's full test suite (`npm test -- --run`) and Playwright smoke test — nothing in v2 should have broken v1's domain layer, since nothing in Phase 1–3 modified v1's existing files beyond the additive extensions named in each task.
- [ ] Walk v1's "Definition of a quality first release" checklist again end-to-end (still must all pass).
- [ ] New v2 checklist: complete onboarding through the new welcome screen and optional passcode step; verify an idle period logs an event and appears in History/Review; create a task, break it down, start a session from a breakdown item, confirm completion marks it done; join a friend group via invite code and confirm live status, a nudge, an unlock request, and a daily digest all reach the second account correctly gated by that account's own privacy settings; trigger a distraction with the network on (AI message) and off (static fallback); request and redeem a temporary passcode by hostname only; join a Study Room video call with a second account; send a Producer Tag both to a friend and into a room.
- [ ] Confirm no API keys (Anthropic, Resend, LiveKit) appear anywhere in `.output/` after a production build — grep the built bundle for the literal secret values as a final check.

---

## Definition of done for v2

- Every task above has passing tests/verification per its own "Definition of done."
- Task 15's full regression pass has run once with no unresolved gaps.
- `grep` across `.output/` for any Supabase/Anthropic/Resend/LiveKit secret values returns nothing.
- No file under `src/domain/session/`, `src/domain/sites/`, or `src/domain/pressure/` changed shape beyond the two named extensions in Task 2 (`SessionEventType`) and Task 4 (`StudySession.taskBreakdownItemId`) — verified by diffing those files against v1's committed versions.

## Self-review

**Spec coverage.** Every item from `docs/V2_Scope_Summary.md`'s Group A (arch overview's Accountability + relevant Long-term carryovers) and Group B (all 8 new asks) maps to a task: Onboarding → Task 1, Activity Tracker → Task 2, History/Review → Task 3, Task Vault → Task 4, backend/friend groups/invite codes/permissions → Task 5, live status → Task 6, nudges/per-friend settings/rate limits → Task 7, unlock requests → Task 8, daily digest → Task 9, privacy/notification prefs → Task 10, coaching messages → Task 11, temp passcodes → Task 12, Study Rooms → Task 13, Producer Tags → Task 14. Items still deferred (FCM push, offline sync, multi-device, cross-browser, Play Mode, more personalities, aggregate analytics) are named explicitly in Scope, not silently dropped.

**Dependency consistency.** Phase 1 tasks (1–4) have no `Depends on` referencing Phase 2/3 work — checked. Phase 3 tasks all list Task 5 as a minimum dependency; Task 14 additionally lists Task 13, matching the one cross-track dependency flagged in the scope summary's dependency map.
