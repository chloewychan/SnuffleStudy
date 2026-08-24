# SnuffleStudy V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local-only, single-player v1 of SnuffleStudy — a Chrome MV3 extension with a real study-session engine, soft/hard site restriction, pressure profiles, a placeholder Snuffles overlay, and no backend — matching the "Foundation" and "Core local product" phases of `docs/Draft1_Architecture_Overview.md`.

**Architecture:** TypeScript + React on WXT (Manifest V3). A pure, Chrome-independent domain layer (session state machine, timer math, site classification, hard-block credential, pressure profiles) sits behind a storage-repository abstraction (`chrome.storage.local` for settings/active session, IndexedDB via `idb` for history/events) and a typed message bus connecting the service worker to popup, side panel, options, and content-script surfaces.

**Tech Stack:** TypeScript, React, WXT, Vite, Vitest + `@testing-library/react` + `happy-dom`, `idb`, `fake-indexeddb`, Playwright, Chrome Manifest V3 (`storage`, `alarms`, `notifications`, `idle`, `scripting`, `declarativeNetRequest`; `*://*/*` as an **optional** host permission, never required).

## Global Constraints

- Domain layer code must be importable and testable in plain Node, with no Chrome API access (`docs/Draft1_Architecture_Overview.md` — Domain layer).
- Timers are timestamp-based (`plannedEndAt - Date.now()`), never a running interval; nothing may assume the service worker stays alive between events.
- Never assert certainty about distraction. Use "Unapproved site" / "Possible distraction" copy, never "you are procrastinating."
- The user can always disable pressure or end a session, **except** that once a hard-block passcode is configured, both visiting a hard-restricted site and disabling pressure require that passcode (arch overview — Site restriction modes).
- No broad host permission at install time. `*://*/*` is requested via `chrome.permissions.request` only when the user opts into the detailed tracking tier; a hard-restricted hostname's permission is requested only when that site is set to hard mode.
- Every entry in the animation registry carries a required `staticFrame` — reduced-motion mode must never depend on someone remembering to add one per state.
- No backend in this plan. Supabase, Firebase, friend accountability, and daily digests are explicitly out of scope (see Scope below) — their interfaces are left extensible, not implemented.

---

## Scope for v1

This plan implements exactly the arch overview's **Foundation** + **Core local product** phases. Everything below is a deliberate scope line, not an oversight.

**In scope:**
- Project scaffolding (WXT, TypeScript, manifest, testing).
- Shared types, session state machine, timer math, site classification, hard-block credential, pressure profiles (data-driven, all 6 example profiles), session validation.
- Storage repositories: `chrome.storage.local` for settings/active session/hard-block credential, IndexedDB for session history and event log.
- Typed messaging between service worker and UI surfaces.
- Background service worker: message routing, alarm-driven auto-complete/break-end, tab-based distraction detection (detailed tracking tier only), `declarativeNetRequest` hard-block redirect sync.
- Popup (quick status + controls), side panel (onboarding + session setup + live session view), options page (tracking tier, default site rules, hard-block passcode).
- Onboarding wizard (matches the arch overview's onboarding steps, minus friend-group creation).
- Content-script overlay with a placeholder `AnimationRegistry` (hand-drawn frames are a later, additive swap — see arch overview, Animation assets), soft-mode warning UI, hard-mode locked page with passcode entry.
- Design tokens + `data-theme` theming scaffold (values are placeholders; Figma-driven values land later without restructuring — see arch overview, Design tokens and theming).
- Vitest unit/integration tests for all domain and infrastructure code; one Playwright e2e smoke test.

**Explicitly out of scope (do not implement):**
- Friend groups, invite codes, live session status, nudges (predefined or per-friend), unlock-approval requests, daily digest — everything in the arch overview's "Accountability product" phase.
- Supabase, Firebase Cloud Messaging, any backend sync.
- Real hand-drawn animation frames (the registry ships with single-static-frame placeholders per state).
- Figma-sourced visual design (tokens exist with placeholder values only).
- Analytics dashboard, multi-device sync, cross-browser support, Play Mode mini-games/cosmetics, additional Snuffles personalities beyond the 6 seeded pressure profiles.
- Email/SMS notifications.

If a task below needs something from this "out of scope" list, it stubs the extension point (e.g. `accountabilityUserIds: []` stays on `StudySession`) without building behavior behind it.

---

## Decisions and clarifications beyond the architecture overview

The arch overview is a product/architecture document, not a build spec — a few things needed a concrete answer before Claude Code could execute this. Each is a real decision, not a guess left open:

1. **`SessionEvent`, `CreateSessionInput`, `HistoryQuery` were referenced but never defined** in the arch overview (`SessionRepository.recordEvent(event: SessionEvent)` etc.). Task 2 defines all three concretely.
2. **The content-script overlay conflicts with the "activity-only tier needs no host permissions" promise.** Rendering Snuffles as an in-page overlay on arbitrary sites requires host permissions to inject a content script there, full stop — that's true regardless of tracking tier. Resolution: the in-page overlay is gated behind the **detailed tracking** permission grant. In **activity-only** mode, session status lives only in the popup and side panel (which need no host permissions, since they're the extension's own pages) — there is no in-page companion. This is stated explicitly here because it's a real behavioral difference between tiers that the arch overview didn't spell out.
3. **The arch overview's `SessionRepository` interface bundled `getActive/saveActive` with `archive/listHistory/recordEvent` in one interface.** This plan splits it along the same line the arch overview's own Storage strategy section draws: `getActiveSession`/`saveActiveSession` live on a `SettingsRepository` backed by `chrome.storage.local` (hot, small data), while `archive`/`listHistory`/`recordEvent` live on a `SessionRepository` backed by IndexedDB (history, event log). Same data, cleaner fit to the two backing stores already specified.
4. **`UserSettings` lives in `domain/settings/`, not `infrastructure/storage/`.** It's referenced both by the storage repository and by `shared/messages.ts` (for `SETTINGS_SAVE`); putting it in infrastructure would make `shared/` depend on `infrastructure/`, backwards from the arch overview's own layering. It's domain data (what the user configured), so it belongs in the domain layer.
5. **The repository structure names the config file `manifest.config.ts`; WXT's actual config entry point is `wxt.config.ts`.** This plan uses `wxt.config.ts` so the project actually builds. `manifest.config.ts` doesn't exist as a WXT convention.
6. **`declarativeNetRequest` rules for hard mode need a target permission.** Rather than requesting broad `<all_urls>` for hard-block enforcement, this plan requests the specific hostname as an optional host permission at the moment the user sets that site to hard mode (`chrome.permissions.request({ origins: [...] })`), consistent with the "smallest permission footprint" principle already established for tracking tiers.
7. **Pressure profile message selection is random-with-membership**, not deterministic, so tests assert pool membership rather than mocking `Math.random`.
8. **Hard-block credential hashing runs under Vitest's `node` environment** (via a `// @vitest-environment node` file pragma), not `happy-dom`, so `crypto.subtle` is guaranteed to behave like the real service worker's Web Crypto implementation — this is also what makes the domain layer's "testable in Node" requirement literally true for this file.

---

## File structure

```text
snufflestudy/
├── src/
│   ├── app/
│   │   └── routes/
│   │       ├── OnboardingWizard.tsx
│   │       └── LockedPage.tsx
│   │
│   ├── background/
│   │   ├── index.ts
│   │   ├── alarmHandlers.ts
│   │   ├── tabHandlers.ts
│   │   └── messageRouter.ts
│   │
│   ├── popup/
│   │   ├── PopupApp.tsx
│   │   └── hooks/
│   │       └── useActiveSession.ts
│   │
│   ├── sidepanel/
│   │   ├── SidePanelApp.tsx
│   │   └── components/
│   │       └── SessionSetupForm.tsx
│   │
│   ├── content/
│   │   ├── index.ts
│   │   ├── siteContext.ts
│   │   ├── pageActivity.ts
│   │   └── overlay/
│   │       ├── SnufflesOverlay.tsx
│   │       ├── overlayHost.ts
│   │       ├── movementController.ts
│   │       └── animationRegistry.ts
│   │
│   ├── options/
│   │   └── OptionsApp.tsx
│   │
│   ├── domain/
│   │   ├── session/
│   │   │   ├── sessionTypes.ts
│   │   │   ├── sessionMachine.ts
│   │   │   ├── timer.ts
│   │   │   └── sessionValidation.ts
│   │   ├── sites/
│   │   │   ├── hostnameMatching.ts
│   │   │   ├── siteRules.ts
│   │   │   └── hardBlockCredential.ts
│   │   ├── pressure/
│   │   │   ├── pressureProfiles.ts
│   │   │   └── pressureEngine.ts
│   │   └── settings/
│   │       └── userSettings.ts
│   │
│   ├── infrastructure/
│   │   ├── storage/
│   │   │   ├── storageRepository.ts
│   │   │   ├── chromeStorageRepository.ts
│   │   │   └── indexedDbRepository.ts
│   │   ├── browser/
│   │   │   ├── tabsApi.ts
│   │   │   ├── alarmsApi.ts
│   │   │   ├── notificationsApi.ts
│   │   │   ├── declarativeNetRequestApi.ts
│   │   │   └── permissionsApi.ts
│   │   └── messaging/
│   │       └── extensionMessenger.ts
│   │
│   ├── shared/
│   │   ├── messages.ts
│   │   └── ui/
│   │       ├── TimerRing.tsx
│   │       └── SessionStatusCard.tsx
│   │
│   └── styles/
│       ├── tokens.css
│       ├── global.css
│       └── themes.css
│
├── public/
│   ├── icons/
│   ├── sprites/
│   │   ├── placeholder-focused.png
│   │   ├── placeholder-angry.png
│   │   ├── placeholder-disappointed.png
│   │   ├── placeholder-proud.png
│   │   └── placeholder-celebratory.png
│   └── locked.html
│
├── tests/
│   └── e2e/
│       └── session-lifecycle.spec.ts
│
├── wxt.config.ts
├── vitest.config.ts
├── vitest.setup.ts
├── playwright.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

Notes vs. the arch overview's full-product tree: `domain/accountability/`, `domain/analytics/`, `infrastructure/backend/`, and the `app/providers/`, `app/appConfig.ts`, `options/pages/`, `popup/pages/`, `popup/components/` subfolders are all out of v1 scope and are not created by this plan — add them when the Accountability phase starts. `tests/unit/` and `tests/integration/` aren't separate folders here; per-module `*.test.ts` files sit next to the code they test (Vitest convention, easier to keep in sync).

---

## Build order

1. **Phase 0 — Scaffolding** (Task 1): project boots, empty popup/side panel/options/background/content load in Chrome.
2. **Phase 1 — Domain layer** (Tasks 2–8): pure, Node-testable session/site/pressure logic. No Chrome APIs.
3. **Phase 2 — Storage** (Tasks 9–10): repositories over `chrome.storage.local` and IndexedDB.
4. **Phase 3 — Messaging & background** (Tasks 11–13): typed message bus, browser API wrappers, service worker wiring — this is where domain + storage become an actual running session engine.
5. **Phase 4 — Presentation** (Tasks 14–18): popup, onboarding, side panel, options — a user can now run a full session from the UI.
6. **Phase 5 — Content script & overlay** (Tasks 19–21): in-page Snuffles, soft-mode warnings, hard-mode locked page.
7. **Phase 6 — Styling foundation** (Task 22): tokens/theming scaffold.
8. **Phase 7 — Verification** (Tasks 23–24): Playwright smoke test, manual QA against the arch overview's Definition of a quality first release.

Each phase only depends on earlier phases — nothing in Phase 4 needs Phase 5, so a subagent-per-task executor can parallelize within a phase once its prerequisites land.

---

## Tasks

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `vitest.setup.ts`, `playwright.config.ts`
- Create: `public/icons/` (any placeholder 16/48/128px PNGs), `public/sprites/` (empty dir, populated in Task 20)

**Interfaces:**
- Produces: a project that runs `npm run dev` (WXT dev server, loadable as an unpacked extension), `npm test` (Vitest), `npm run test:e2e` (Playwright), `npm run build` (produces `.output/chrome-mv3` for Task 23).

- [ ] **Step 1: Scaffold the WXT project**

```bash
npx wxt@latest init snufflestudy -t react
cd snufflestudy
```

- [ ] **Step 2: Install v1 dependencies**

```bash
npm install idb
npm install -D vitest happy-dom @testing-library/react @testing-library/jest-dom @testing-library/user-event fake-indexeddb @playwright/test
```

- [ ] **Step 3: Write `wxt.config.ts`**

```ts
import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "SnuffleStudy",
    description: "A consensual peer-pressure study accountability companion.",
    permissions: ["storage", "alarms", "notifications", "idle", "scripting", "declarativeNetRequest"],
    optional_host_permissions: ["*://*/*"],
    side_panel: {
      default_path: "sidepanel.html",
    },
  },
});
```

- [ ] **Step 4: Write `vitest.config.ts` and `vitest.setup.ts`**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
```

```ts
// vitest.setup.ts
import "@testing-library/jest-dom/vitest";
```

Domain-layer test files that need real Web Crypto (Task 6) override the environment per-file with a `// @vitest-environment node` pragma at the top of the file — see that task.

- [ ] **Step 5: Write `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
});
```

- [ ] **Step 6: Verify the dev server builds**

Run: `npm run dev`
Expected: WXT prints a `.output/chrome-mv3-dev` path with no build errors. Load it in Chrome via `chrome://extensions` → "Load unpacked" and confirm the extension icon appears with no console errors.

- [ ] **Step 7: Verify test runners are wired**

Run: `npm test -- --run`
Expected: Vitest runs with zero test files found (not an error) — confirms config loads.

Run: `npx playwright install chromium`
Expected: Playwright's Chromium binary installs successfully.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold WXT project with test tooling"
```

---

### Task 2: Shared session types

**Files:**
- Create: `src/domain/session/sessionTypes.ts`
- Test: `src/domain/session/sessionTypes.test.ts`

**Interfaces:**
- Produces: `SessionState`, `InterventionLevel`, `RestrictionMode`, `StudySession`, `CreateSessionInput`, `SessionEventType`, `SessionEvent`, `HistoryQuery` — every later domain/infrastructure/UI task imports from here.

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/session/sessionTypes.test.ts
import { describe, it, expect } from "vitest";
import type {
  StudySession,
  CreateSessionInput,
  SessionEvent,
} from "./sessionTypes";

describe("sessionTypes", () => {
  it("accepts a fully-formed StudySession object", () => {
    const session: StudySession = {
      id: "session_1",
      goal: "Finish 20 chemistry problems",
      state: "FOCUSING",
      interventionLevel: "none",
      createdAt: 1000,
      startedAt: 1000,
      plannedEndAt: 2000,
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "strict-coach",
      allowedSites: ["docs.google.com"],
      restrictedSites: ["youtube.com"],
      restrictionMode: "soft",
      accountabilityUserIds: [],
      distractionAttempts: 0,
      recoveries: 0,
      friendNudges: 0,
    };

    expect(session.state).toBe("FOCUSING");
  });

  it("accepts a minimal CreateSessionInput", () => {
    const input: CreateSessionInput = {
      goal: "Read chapters 3 and 4",
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "gentle-encouragement",
      allowedSites: [],
      restrictedSites: [],
      restrictionMode: "soft",
    };

    expect(input.restrictionMode).toBe("soft");
  });

  it("accepts a SessionEvent", () => {
    const event: SessionEvent = {
      id: "event_1",
      sessionId: "session_1",
      type: "DISTRACTION_ATTEMPT",
      occurredAt: 1500,
      hostname: "youtube.com",
    };

    expect(event.type).toBe("DISTRACTION_ATTEMPT");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- sessionTypes --run`
Expected: FAIL — `./sessionTypes` has no exported member `StudySession` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/session/sessionTypes.ts
export type SessionState =
  | "IDLE"
  | "SESSION_SETUP"
  | "FOCUSING"
  | "PAUSED"
  | "BREAK"
  | "COMPLETED"
  | "ABANDONED";

export type InterventionLevel = "none" | "warned" | "escalated";

export type RestrictionMode = "soft" | "hard";

export interface StudySession {
  id: string;
  goal: string;
  state: SessionState;
  interventionLevel: InterventionLevel;

  createdAt: number;
  startedAt?: number;
  plannedEndAt?: number;
  pausedAt?: number;
  breakStartedAt?: number;
  breakEndsAt?: number;
  completedAt?: number;
  endedAt?: number;

  focusDurationSeconds: number;
  breakDurationSeconds: number;
  remainingSeconds?: number;

  pressureProfileId: string;
  allowedSites: string[];
  restrictedSites: string[];
  restrictionMode: RestrictionMode;
  siteRestrictionOverrides?: Record<string, RestrictionMode>;

  accountabilityGroupId?: string;
  accountabilityUserIds: string[];

  distractionAttempts: number;
  recoveries: number;
  friendNudges: number;
}

export interface CreateSessionInput {
  goal: string;
  focusDurationSeconds: number;
  breakDurationSeconds: number;
  pressureProfileId: string;
  allowedSites: string[];
  restrictedSites: string[];
  restrictionMode: RestrictionMode;
  siteRestrictionOverrides?: Record<string, RestrictionMode>;
}

export type SessionEventType =
  | "SESSION_CREATED"
  | "SESSION_STARTED"
  | "SESSION_PAUSED"
  | "SESSION_RESUMED"
  | "SESSION_BREAK_STARTED"
  | "SESSION_BREAK_ENDED"
  | "DISTRACTION_ATTEMPT"
  | "SITE_MARKED_STUDY_RELATED"
  | "HARD_BLOCK_UNLOCK"
  | "RECOVERY"
  | "SESSION_COMPLETED"
  | "SESSION_ABANDONED";

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: SessionEventType;
  occurredAt: number;
  hostname?: string;
  reason?: string;
}

export interface HistoryQuery {
  limit?: number;
  since?: number;
  state?: SessionState;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- sessionTypes --run`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/session/sessionTypes.ts src/domain/session/sessionTypes.test.ts
git commit -m "feat: add shared session types"
```

---

### Task 3: Session state machine

**Files:**
- Create: `src/domain/session/sessionMachine.ts`
- Test: `src/domain/session/sessionMachine.test.ts`

**Interfaces:**
- Consumes: `StudySession`, `CreateSessionInput`, `SessionState`, `InterventionLevel` from `./sessionTypes` (Task 2).
- Produces: `createSession`, `startSession`, `pauseSession`, `resumeSession`, `startBreak`, `endBreak`, `completeSession`, `abandonSession`, `warnSession`, `escalateSession`, `clearIntervention`, `recordDistractionAttempt`, `recordRecovery` — all pure `(session, now) => session` transforms (or `(session) => session` where `now` isn't needed), all throwing `Error` on an invalid transition. Task 13 (background wiring) is the primary consumer.

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/session/sessionMachine.test.ts
import { describe, it, expect } from "vitest";
import * as machine from "./sessionMachine";
import type { CreateSessionInput } from "./sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
};

describe("sessionMachine", () => {
  it("creates a session in SESSION_SETUP", () => {
    const session = machine.createSession(input, "session_1", 1000);
    expect(session.state).toBe("SESSION_SETUP");
    expect(session.interventionLevel).toBe("none");
    expect(session.distractionAttempts).toBe(0);
  });

  it("starts a session and computes plannedEndAt", () => {
    const created = machine.createSession(input, "session_1", 1000);
    const started = machine.startSession(created, 1000);
    expect(started.state).toBe("FOCUSING");
    expect(started.plannedEndAt).toBe(1000 + 1500 * 1000);
  });

  it("refuses to start a session that isn't in SESSION_SETUP", () => {
    const created = machine.createSession(input, "session_1", 1000);
    const started = machine.startSession(created, 1000);
    expect(() => machine.startSession(started, 2000)).toThrow(
      "Cannot start a session in state FOCUSING"
    );
  });

  it("pauses and resumes, preserving remaining time", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const paused = machine.pauseSession(started, 400_000);
    expect(paused.state).toBe("PAUSED");
    expect(paused.remainingSeconds).toBe(1100);
    expect(paused.plannedEndAt).toBeUndefined();

    const resumed = machine.resumeSession(paused, 500_000);
    expect(resumed.state).toBe("FOCUSING");
    expect(resumed.plannedEndAt).toBe(500_000 + 1100 * 1000);
  });

  it("starts and ends a break, returning to FOCUSING with a fresh plannedEndAt", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const onBreak = machine.startBreak(started, 100_000);
    expect(onBreak.state).toBe("BREAK");
    expect(onBreak.breakEndsAt).toBe(100_000 + 300 * 1000);

    const backToFocus = machine.endBreak(onBreak, 400_000);
    expect(backToFocus.state).toBe("FOCUSING");
    expect(backToFocus.plannedEndAt).toBe(400_000 + 1500 * 1000);
  });

  it("completes a focusing session", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const completed = machine.completeSession(started, 1_500_000);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.completedAt).toBe(1_500_000);
  });

  it("abandons a session from any non-terminal state", () => {
    const created = machine.createSession(input, "session_1", 0);
    const abandoned = machine.abandonSession(created, 5000);
    expect(abandoned.state).toBe("ABANDONED");
    expect(abandoned.endedAt).toBe(5000);
  });

  it("refuses to abandon an already-terminal session", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const completed = machine.completeSession(started, 1_500_000);
    expect(() => machine.abandonSession(completed, 1_600_000)).toThrow(
      "Cannot abandon a session in state COMPLETED"
    );
  });

  it("tracks intervention level independently of session state", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const warned = machine.warnSession(started);
    expect(warned.interventionLevel).toBe("warned");
    expect(warned.state).toBe("FOCUSING");

    const paused = machine.pauseSession(warned, 100_000);
    expect(paused.interventionLevel).toBe("warned");
    expect(paused.state).toBe("PAUSED");

    const escalated = machine.escalateSession(paused);
    expect(escalated.interventionLevel).toBe("escalated");

    const cleared = machine.clearIntervention(escalated);
    expect(cleared.interventionLevel).toBe("none");
  });

  it("records distraction attempts and recoveries", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const distracted = machine.recordDistractionAttempt(machine.warnSession(started));
    expect(distracted.distractionAttempts).toBe(1);
    expect(distracted.interventionLevel).toBe("warned");

    const recovered = machine.recordRecovery(distracted);
    expect(recovered.recoveries).toBe(1);
    expect(recovered.interventionLevel).toBe("none");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- sessionMachine --run`
Expected: FAIL — module `./sessionMachine` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/session/sessionMachine.ts
import type { CreateSessionInput, StudySession } from "./sessionTypes";

export function createSession(
  input: CreateSessionInput,
  id: string,
  now: number
): StudySession {
  return {
    id,
    goal: input.goal,
    state: "SESSION_SETUP",
    interventionLevel: "none",
    createdAt: now,
    focusDurationSeconds: input.focusDurationSeconds,
    breakDurationSeconds: input.breakDurationSeconds,
    pressureProfileId: input.pressureProfileId,
    allowedSites: input.allowedSites,
    restrictedSites: input.restrictedSites,
    restrictionMode: input.restrictionMode,
    siteRestrictionOverrides: input.siteRestrictionOverrides,
    accountabilityUserIds: [],
    distractionAttempts: 0,
    recoveries: 0,
    friendNudges: 0,
  };
}

export function startSession(session: StudySession, now: number): StudySession {
  if (session.state !== "SESSION_SETUP") {
    throw new Error(`Cannot start a session in state ${session.state}`);
  }
  return {
    ...session,
    state: "FOCUSING",
    startedAt: now,
    plannedEndAt: now + session.focusDurationSeconds * 1000,
  };
}

export function pauseSession(session: StudySession, now: number): StudySession {
  if (session.state !== "FOCUSING") {
    throw new Error(`Cannot pause a session in state ${session.state}`);
  }
  const remainingSeconds = Math.max(
    0,
    Math.round(((session.plannedEndAt ?? now) - now) / 1000)
  );
  return {
    ...session,
    state: "PAUSED",
    pausedAt: now,
    remainingSeconds,
    plannedEndAt: undefined,
  };
}

export function resumeSession(session: StudySession, now: number): StudySession {
  if (session.state !== "PAUSED") {
    throw new Error(`Cannot resume a session in state ${session.state}`);
  }
  const remainingSeconds = session.remainingSeconds ?? session.focusDurationSeconds;
  return {
    ...session,
    state: "FOCUSING",
    pausedAt: undefined,
    plannedEndAt: now + remainingSeconds * 1000,
    remainingSeconds: undefined,
  };
}

export function startBreak(session: StudySession, now: number): StudySession {
  if (session.state !== "FOCUSING") {
    throw new Error(`Cannot start a break from state ${session.state}`);
  }
  return {
    ...session,
    state: "BREAK",
    breakStartedAt: now,
    breakEndsAt: now + session.breakDurationSeconds * 1000,
    plannedEndAt: undefined,
  };
}

export function endBreak(session: StudySession, now: number): StudySession {
  if (session.state !== "BREAK") {
    throw new Error(`Cannot end a break from state ${session.state}`);
  }
  return {
    ...session,
    state: "FOCUSING",
    breakStartedAt: undefined,
    breakEndsAt: undefined,
    plannedEndAt: now + session.focusDurationSeconds * 1000,
  };
}

export function completeSession(session: StudySession, now: number): StudySession {
  if (session.state !== "FOCUSING") {
    throw new Error(`Cannot complete a session in state ${session.state}`);
  }
  return { ...session, state: "COMPLETED", completedAt: now, endedAt: now };
}

export function abandonSession(session: StudySession, now: number): StudySession {
  if (session.state === "COMPLETED" || session.state === "ABANDONED") {
    throw new Error(`Cannot abandon a session in state ${session.state}`);
  }
  return { ...session, state: "ABANDONED", endedAt: now };
}

export function warnSession(session: StudySession): StudySession {
  if (session.interventionLevel === "escalated") return session;
  return { ...session, interventionLevel: "warned" };
}

export function escalateSession(session: StudySession): StudySession {
  return { ...session, interventionLevel: "escalated" };
}

export function clearIntervention(session: StudySession): StudySession {
  return { ...session, interventionLevel: "none" };
}

export function recordDistractionAttempt(session: StudySession): StudySession {
  return { ...session, distractionAttempts: session.distractionAttempts + 1 };
}

export function recordRecovery(session: StudySession): StudySession {
  return {
    ...session,
    recoveries: session.recoveries + 1,
    interventionLevel: "none",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- sessionMachine --run`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/session/sessionMachine.ts src/domain/session/sessionMachine.test.ts
git commit -m "feat: add pure session state machine"
```

---

### Task 4: Timer calculations

**Files:**
- Create: `src/domain/session/timer.ts`
- Test: `src/domain/session/timer.test.ts`

**Interfaces:**
- Consumes: `StudySession` from `./sessionTypes` (Task 2).
- Produces: `remainingSeconds(session, now)`, `isTimerExpired(session, now)`. Consumed by `TimerRing` (Task 14), popup/side panel (Tasks 15, 17), and `alarmHandlers.ts` (Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/session/timer.test.ts
import { describe, it, expect } from "vitest";
import { remainingSeconds, isTimerExpired } from "./timer";
import * as machine from "./sessionMachine";
import type { CreateSessionInput } from "./sessionTypes";

const input: CreateSessionInput = {
  goal: "Read chapters 3 and 4",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("timer", () => {
  it("computes remaining seconds while FOCUSING from plannedEndAt, not a stored counter", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    expect(remainingSeconds(started, 400_000)).toBe(1100);
  });

  it("survives a simulated browser restart — remaining time is derived, not stored state", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    // Simulate reading the same session object back after the service worker
    // was killed and restarted 10 minutes later — no special restore logic needed.
    expect(remainingSeconds(started, 600_000)).toBe(900);
  });

  it("returns the saved remainingSeconds while PAUSED", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const paused = machine.pauseSession(started, 400_000);
    expect(remainingSeconds(paused, 999_999_999)).toBe(1100);
  });

  it("computes remaining seconds from breakEndsAt while on BREAK", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    const onBreak = machine.startBreak(started, 0);
    expect(remainingSeconds(onBreak, 100_000)).toBe(200);
  });

  it("never returns a negative value", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    expect(remainingSeconds(started, 999_999_999)).toBe(0);
  });

  it("returns 0 for a session with no active timer", () => {
    const created = machine.createSession(input, "session_1", 0);
    expect(remainingSeconds(created, 0)).toBe(0);
  });

  it("reports isTimerExpired correctly for FOCUSING", () => {
    const created = machine.createSession(input, "session_1", 0);
    const started = machine.startSession(created, 0);
    expect(isTimerExpired(started, 1500 * 1000 - 1)).toBe(false);
    expect(isTimerExpired(started, 1500 * 1000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- timer --run`
Expected: FAIL — module `./timer` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/session/timer.ts
import type { StudySession } from "./sessionTypes";

export function remainingSeconds(session: StudySession, now: number): number {
  if (session.state === "PAUSED") {
    return session.remainingSeconds ?? 0;
  }
  if (session.state === "FOCUSING" && session.plannedEndAt) {
    return Math.max(0, Math.round((session.plannedEndAt - now) / 1000));
  }
  if (session.state === "BREAK" && session.breakEndsAt) {
    return Math.max(0, Math.round((session.breakEndsAt - now) / 1000));
  }
  return 0;
}

export function isTimerExpired(session: StudySession, now: number): boolean {
  if (session.state === "FOCUSING" && session.plannedEndAt) {
    return now >= session.plannedEndAt;
  }
  if (session.state === "BREAK" && session.breakEndsAt) {
    return now >= session.breakEndsAt;
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- timer --run`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/session/timer.ts src/domain/session/timer.test.ts
git commit -m "feat: add timestamp-based timer calculations"
```

---

### Task 5: Hostname matching and site classification

**Files:**
- Create: `src/domain/sites/hostnameMatching.ts`, `src/domain/sites/siteRules.ts`
- Test: `src/domain/sites/hostnameMatching.test.ts`, `src/domain/sites/siteRules.test.ts`

**Interfaces:**
- Consumes: `StudySession`, `RestrictionMode` from `../session/sessionTypes` (Task 2).
- Produces: `isHostnameInList(hostname, list)`, `SiteClassification` ("ALLOWED"|"BLOCKED"|"UNKNOWN"|"UNAVAILABLE"), `classifySite(session, hostname)`, `restrictionModeFor(session, hostname)`. Consumed by `messageRouter.ts` and `tabHandlers.ts` (Task 13) and `SnufflesOverlay` (Task 20).

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/sites/hostnameMatching.test.ts
import { describe, it, expect } from "vitest";
import { isHostnameInList } from "./hostnameMatching";

describe("isHostnameInList", () => {
  it("matches an exact hostname", () => {
    expect(isHostnameInList("youtube.com", ["youtube.com"])).toBe(true);
  });

  it("matches a subdomain of a listed hostname", () => {
    expect(isHostnameInList("m.youtube.com", ["youtube.com"])).toBe(true);
  });

  it("does not match an unrelated hostname", () => {
    expect(isHostnameInList("youtube.com.evil.example", ["youtube.com"])).toBe(false);
  });

  it("does not match a hostname that merely contains the listed string", () => {
    expect(isHostnameInList("notyoutube.com", ["youtube.com"])).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(isHostnameInList("youtube.com", [])).toBe(false);
  });
});
```

```ts
// src/domain/sites/siteRules.test.ts
import { describe, it, expect } from "vitest";
import { classifySite, restrictionModeFor } from "./siteRules";
import * as machine from "../session/sessionMachine";
import type { CreateSessionInput } from "../session/sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: ["docs.google.com"],
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
  siteRestrictionOverrides: { "reddit.com": "hard" },
};

describe("siteRules", () => {
  const session = machine.createSession(input, "session_1", 0);

  it("classifies an allowed site as ALLOWED", () => {
    expect(classifySite(session, "docs.google.com")).toBe("ALLOWED");
  });

  it("classifies a restricted site as BLOCKED", () => {
    expect(classifySite(session, "youtube.com")).toBe("BLOCKED");
  });

  it("classifies an unlisted site as UNKNOWN", () => {
    expect(classifySite(session, "example.com")).toBe("UNKNOWN");
  });

  it("classifies a null hostname (privileged page) as UNAVAILABLE", () => {
    expect(classifySite(session, null)).toBe("UNAVAILABLE");
  });

  it("resolves restriction mode from the session default", () => {
    expect(restrictionModeFor(session, "youtube.com")).toBe("soft");
  });

  it("resolves restriction mode from a per-site override", () => {
    expect(restrictionModeFor(session, "reddit.com")).toBe("hard");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- hostnameMatching siteRules --run`
Expected: FAIL — neither module exists yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/sites/hostnameMatching.ts
export function isHostnameInList(hostname: string, list: string[]): boolean {
  return list.some((site) => hostname === site || hostname.endsWith(`.${site}`));
}
```

```ts
// src/domain/sites/siteRules.ts
import type { StudySession, RestrictionMode } from "../session/sessionTypes";
import { isHostnameInList } from "./hostnameMatching";

export type SiteClassification = "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";

export function classifySite(session: StudySession, hostname: string | null): SiteClassification {
  if (hostname === null) return "UNAVAILABLE";
  if (isHostnameInList(hostname, session.allowedSites)) return "ALLOWED";
  if (isHostnameInList(hostname, session.restrictedSites)) return "BLOCKED";
  return "UNKNOWN";
}

export function restrictionModeFor(session: StudySession, hostname: string): RestrictionMode {
  return session.siteRestrictionOverrides?.[hostname] ?? session.restrictionMode;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- hostnameMatching siteRules --run`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/sites/hostnameMatching.ts src/domain/sites/siteRules.ts src/domain/sites/hostnameMatching.test.ts src/domain/sites/siteRules.test.ts
git commit -m "feat: add hostname matching and site classification"
```

---

### Task 6: Hard-block credential

**Files:**
- Create: `src/domain/sites/hardBlockCredential.ts`
- Test: `src/domain/sites/hardBlockCredential.test.ts`

**Interfaces:**
- Produces: `HardBlockCredential`, `createHardBlockCredential(passcode)`, `verifyPasscode(credential, passcode, now)`. Consumed by `messageRouter.ts` (Task 13), `OptionsApp` (Task 18), `LockedPage` (Task 21).

- [ ] **Step 1: Write the failing tests**

This file needs a real Web Crypto implementation, not `happy-dom`'s. Pin its test environment explicitly:

```ts
// src/domain/sites/hardBlockCredential.test.ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHardBlockCredential, verifyPasscode } from "./hardBlockCredential";

describe("hardBlockCredential", () => {
  it("verifies the correct passcode", async () => {
    const credential = await createHardBlockCredential("1234");
    const result = await verifyPasscode(credential, "1234", 0);
    expect(result.success).toBe(true);
    expect(result.credential.failedAttempts).toBe(0);
  });

  it("rejects an incorrect passcode and increments failedAttempts", async () => {
    const credential = await createHardBlockCredential("1234");
    const result = await verifyPasscode(credential, "0000", 0);
    expect(result.success).toBe(false);
    expect(result.credential.failedAttempts).toBe(1);
  });

  it("never stores the passcode in plaintext", async () => {
    const credential = await createHardBlockCredential("1234");
    expect(credential.passcodeHash).not.toContain("1234");
    expect(JSON.stringify(credential)).not.toContain("1234");
  });

  it("locks out after 3 failed attempts", async () => {
    let credential = await createHardBlockCredential("1234");
    for (let i = 0; i < 3; i++) {
      const result = await verifyPasscode(credential, "0000", i * 1000);
      credential = result.credential;
    }
    expect(credential.lockedUntil).toBeDefined();

    const duringLockout = await verifyPasscode(credential, "1234", credential.lockedUntil! - 1);
    expect(duringLockout.success).toBe(false);

    const afterLockout = await verifyPasscode(credential, "1234", credential.lockedUntil! + 1);
    expect(afterLockout.success).toBe(true);
  });

  it("resets failedAttempts after a successful verification", async () => {
    let credential = await createHardBlockCredential("1234");
    const failed = await verifyPasscode(credential, "0000", 0);
    credential = failed.credential;
    expect(credential.failedAttempts).toBe(1);

    const succeeded = await verifyPasscode(credential, "1234", 1000);
    expect(succeeded.credential.failedAttempts).toBe(0);
    expect(succeeded.credential.lockedUntil).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- hardBlockCredential --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/sites/hardBlockCredential.ts
export interface HardBlockCredential {
  passcodeHash: string;
  passcodeSalt: string;
  failedAttempts: number;
  lockedUntil?: number;
}

const MAX_ATTEMPTS_BEFORE_LOCKOUT = 3;
const LOCKOUT_DURATION_MS = 60_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toHex(bytes.buffer);
}

async function hashPasscode(passcode: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${salt}:${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function createHardBlockCredential(passcode: string): Promise<HardBlockCredential> {
  const passcodeSalt = randomSalt();
  const passcodeHash = await hashPasscode(passcode, passcodeSalt);
  return { passcodeHash, passcodeSalt, failedAttempts: 0 };
}

export async function verifyPasscode(
  credential: HardBlockCredential,
  passcode: string,
  now: number
): Promise<{ credential: HardBlockCredential; success: boolean }> {
  if (credential.lockedUntil && now < credential.lockedUntil) {
    return { credential, success: false };
  }

  const candidateHash = await hashPasscode(passcode, credential.passcodeSalt);
  if (candidateHash === credential.passcodeHash) {
    return {
      credential: { ...credential, failedAttempts: 0, lockedUntil: undefined },
      success: true,
    };
  }

  const failedAttempts = credential.failedAttempts + 1;
  const lockedUntil =
    failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCKOUT ? now + LOCKOUT_DURATION_MS : undefined;

  return { credential: { ...credential, failedAttempts, lockedUntil }, success: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- hardBlockCredential --run`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/sites/hardBlockCredential.ts src/domain/sites/hardBlockCredential.test.ts
git commit -m "feat: add hashed, rate-limited hard-block passcode credential"
```

---

### Task 7: Pressure profiles and pressure engine

**Files:**
- Create: `src/domain/pressure/pressureProfiles.ts`, `src/domain/pressure/pressureEngine.ts`
- Test: `src/domain/pressure/pressureProfiles.test.ts`, `src/domain/pressure/pressureEngine.test.ts`

**Interfaces:**
- Consumes: `InterventionLevel` from `../session/sessionTypes` (Task 2).
- Produces: `PressureProfile`, `PRESSURE_PROFILES` (6 seeded profiles), `getPressureProfile(id)`, `pickWarningMessage(pressureProfileId, interventionLevel)`. Consumed by `sessionValidation.ts` (Task 8), `SessionSetupForm` (Task 17), `OnboardingWizard` (Task 16), `SnufflesOverlay` (Task 20).

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/pressure/pressureProfiles.test.ts
import { describe, it, expect } from "vitest";
import { PRESSURE_PROFILES, getPressureProfile } from "./pressureProfiles";

describe("pressureProfiles", () => {
  it("seeds exactly the 6 profiles named in the architecture overview", () => {
    const ids = PRESSURE_PROFILES.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        "gentle-encouragement",
        "strict-coach",
        "ruthless-roaster",
        "parent-mode",
        "hype-squad",
        "silent-enforcement",
      ].sort()
    );
  });

  it("gives every profile at least one message in every required pool", () => {
    for (const profile of PRESSURE_PROFILES) {
      expect(profile.firstWarningMessages.length).toBeGreaterThan(0);
      expect(profile.repeatedWarningMessages.length).toBeGreaterThan(0);
      expect(profile.breakMessages.length).toBeGreaterThan(0);
      expect(profile.completionMessages.length).toBeGreaterThan(0);
      expect(profile.abandonmentMessages.length).toBeGreaterThan(0);
    }
  });

  it("returns a profile by id", () => {
    expect(getPressureProfile("strict-coach").name).toBe("Strict Coach");
  });

  it("throws for an unknown profile id", () => {
    expect(() => getPressureProfile("nonexistent")).toThrow("Unknown pressure profile: nonexistent");
  });
});
```

```ts
// src/domain/pressure/pressureEngine.test.ts
import { describe, it, expect } from "vitest";
import { pickWarningMessage } from "./pressureEngine";
import { getPressureProfile } from "./pressureProfiles";

describe("pressureEngine", () => {
  it("picks a message from firstWarningMessages when interventionLevel is 'warned'", () => {
    const profile = getPressureProfile("strict-coach");
    const message = pickWarningMessage("strict-coach", "warned");
    expect(profile.firstWarningMessages).toContain(message);
  });

  it("picks a message from repeatedWarningMessages when interventionLevel is 'escalated'", () => {
    const profile = getPressureProfile("strict-coach");
    const message = pickWarningMessage("strict-coach", "escalated");
    expect(profile.repeatedWarningMessages).toContain(message);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pressureProfiles pressureEngine --run`
Expected: FAIL — neither module exists yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/pressure/pressureProfiles.ts
export interface PressureProfile {
  id: string;
  name: string;
  intensity: "gentle" | "moderate" | "ruthless";
  description: string;
  firstWarningMessages: string[];
  repeatedWarningMessages: string[];
  breakMessages: string[];
  completionMessages: string[];
  abandonmentMessages: string[];
  animationLevel: "low" | "medium" | "high";
  allowFriendNudges: boolean;
  requireUnlockApproval: boolean;
  maxNudgesPerSession: number;
}

export const PRESSURE_PROFILES: PressureProfile[] = [
  {
    id: "gentle-encouragement",
    name: "Gentle Encouragement",
    intensity: "gentle",
    description: "Warm, supportive nudges. No judgment.",
    firstWarningMessages: ["Hey, is this part of the plan?", "Just checking in — still studying?"],
    repeatedWarningMessages: ["I believe in you. Let's head back?", "No pressure, but your goal is waiting."],
    breakMessages: ["Good work. Rest a little.", "You earned this break."],
    completionMessages: ["You did it! Proud of you.", "Goal complete. Nice work."],
    abandonmentMessages: ["That's okay. Try again soon.", "No shame — reschedule when ready."],
    animationLevel: "low",
    allowFriendNudges: true,
    requireUnlockApproval: false,
    maxNudgesPerSession: 3,
  },
  {
    id: "strict-coach",
    name: "Strict Coach",
    intensity: "moderate",
    description: "Firm, direct, no-nonsense accountability.",
    firstWarningMessages: ["That's not on your list. Back to work.", "Off task. Fix it."],
    repeatedWarningMessages: ["This is the second time. Focus.", "You committed to this. Follow through."],
    breakMessages: ["Break's on the clock. Use it well.", "Recharge, then back at it."],
    completionMessages: ["Goal complete. That's how it's done.", "Solid session. Keep this up."],
    abandonmentMessages: ["Session ended early. Note why, and try again.", "Not today. Reset and go again."],
    animationLevel: "medium",
    allowFriendNudges: true,
    requireUnlockApproval: true,
    maxNudgesPerSession: 5,
  },
  {
    id: "ruthless-roaster",
    name: "Ruthless Roaster",
    intensity: "ruthless",
    description: "Theatrically merciless. Loud, funny, relentless.",
    firstWarningMessages: ["That is NOT chemistry.", "Caught you. Already."],
    repeatedWarningMessages: ["Again? Really?", "Your goals are watching you fail right now."],
    breakMessages: ["Fine. Five minutes. I'm timing you.", "Break granted. Don't get comfortable."],
    completionMessages: ["...okay, that was actually impressive.", "Goal complete. I'm shocked too."],
    abandonmentMessages: ["Wow. Okay. We'll talk about this later.", "Abandoned. Your friends will hear about this."],
    animationLevel: "high",
    allowFriendNudges: true,
    requireUnlockApproval: true,
    maxNudgesPerSession: 8,
  },
  {
    id: "parent-mode",
    name: "Parent Mode",
    intensity: "moderate",
    description: "Caring but exasperated. Classic parent energy.",
    firstWarningMessages: ["Is this really what you should be doing right now?", "I'm not mad, just... focus."],
    repeatedWarningMessages: ["We talked about this.", "I raised you better than this tab."],
    breakMessages: ["Fine, take a break. Drink some water.", "Okay, five minutes. Set a timer."],
    completionMessages: ["I'm so proud of you.", "See? You could do it all along."],
    abandonmentMessages: ["It's fine. We'll try again later.", "Okay. Rest, then come back to it."],
    animationLevel: "medium",
    allowFriendNudges: true,
    requireUnlockApproval: true,
    maxNudgesPerSession: 5,
  },
  {
    id: "hype-squad",
    name: "Hype Squad",
    intensity: "moderate",
    description: "Loud, energetic, relentlessly positive.",
    firstWarningMessages: ["LET'S GO. BACK TO IT.", "Nuh uh. Not today. Refocus!"],
    repeatedWarningMessages: ["You've GOT this. Come on!", "One more distraction and we riot (positively)."],
    breakMessages: ["BREAK TIME. You EARNED it!", "Stretch! Hydrate! Let's gooo!"],
    completionMessages: ["YOU DID THAT.", "GOAL. COMPLETE. LEGENDARY."],
    abandonmentMessages: ["It's not over, it's a plot twist. Try again!", "We regroup and come back stronger!"],
    animationLevel: "high",
    allowFriendNudges: true,
    requireUnlockApproval: false,
    maxNudgesPerSession: 6,
  },
  {
    id: "silent-enforcement",
    name: "Silent Enforcement",
    intensity: "ruthless",
    description: "No commentary. Just strict, quiet enforcement.",
    firstWarningMessages: ["Unapproved site.", "Off task."],
    repeatedWarningMessages: ["Still off task.", "Return to your session."],
    breakMessages: ["Break started.", "Break active."],
    completionMessages: ["Goal complete.", "Session complete."],
    abandonmentMessages: ["Session ended.", "Session abandoned."],
    animationLevel: "low",
    allowFriendNudges: false,
    requireUnlockApproval: true,
    maxNudgesPerSession: 0,
  },
];

export function getPressureProfile(id: string): PressureProfile {
  const profile = PRESSURE_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown pressure profile: ${id}`);
  return profile;
}
```

```ts
// src/domain/pressure/pressureEngine.ts
import type { InterventionLevel } from "../session/sessionTypes";
import { getPressureProfile } from "./pressureProfiles";

export function pickWarningMessage(
  pressureProfileId: string,
  interventionLevel: InterventionLevel
): string {
  const profile = getPressureProfile(pressureProfileId);
  const pool =
    interventionLevel === "escalated" ? profile.repeatedWarningMessages : profile.firstWarningMessages;
  return pool[Math.floor(Math.random() * pool.length)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pressureProfiles pressureEngine --run`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/pressure/pressureProfiles.ts src/domain/pressure/pressureEngine.ts src/domain/pressure/pressureProfiles.test.ts src/domain/pressure/pressureEngine.test.ts
git commit -m "feat: add data-driven pressure profiles and message selection"
```

---

### Task 8: Session validation

**Files:**
- Create: `src/domain/session/sessionValidation.ts`
- Test: `src/domain/session/sessionValidation.test.ts`

**Interfaces:**
- Consumes: `CreateSessionInput` from `./sessionTypes` (Task 2).
- Produces: `ValidationResult`, `validateCreateSessionInput(input)`. Consumed by `messageRouter.ts` (Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/session/sessionValidation.test.ts
import { describe, it, expect } from "vitest";
import { validateCreateSessionInput } from "./sessionValidation";
import type { CreateSessionInput } from "./sessionTypes";

const validInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("validateCreateSessionInput", () => {
  it("accepts a valid input", () => {
    expect(validateCreateSessionInput(validInput)).toEqual({ valid: true, errors: [] });
  });

  it("rejects an empty goal", () => {
    const result = validateCreateSessionInput({ ...validInput, goal: "   " });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Goal cannot be empty.");
  });

  it("rejects a zero focus duration", () => {
    const result = validateCreateSessionInput({ ...validInput, focusDurationSeconds: 0 });
    expect(result.errors).toContain("Focus duration must be greater than zero.");
  });

  it("rejects a zero break duration", () => {
    const result = validateCreateSessionInput({ ...validInput, breakDurationSeconds: 0 });
    expect(result.errors).toContain("Break duration must be greater than zero.");
  });

  it("rejects a missing pressure profile", () => {
    const result = validateCreateSessionInput({ ...validInput, pressureProfileId: "" });
    expect(result.errors).toContain("A pressure profile must be selected.");
  });

  it("collects multiple errors at once", () => {
    const result = validateCreateSessionInput({
      ...validInput,
      goal: "",
      focusDurationSeconds: 0,
    });
    expect(result.errors).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- sessionValidation --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/session/sessionValidation.ts
import type { CreateSessionInput } from "./sessionTypes";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCreateSessionInput(input: CreateSessionInput): ValidationResult {
  const errors: string[] = [];

  if (input.goal.trim().length === 0) errors.push("Goal cannot be empty.");
  if (input.focusDurationSeconds <= 0) errors.push("Focus duration must be greater than zero.");
  if (input.breakDurationSeconds <= 0) errors.push("Break duration must be greater than zero.");
  if (input.pressureProfileId.trim().length === 0) errors.push("A pressure profile must be selected.");

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- sessionValidation --run`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/session/sessionValidation.ts src/domain/session/sessionValidation.test.ts
git commit -m "feat: add session input validation"
```

This completes Phase 1 (domain layer). Every file under `src/domain/` is now implemented and tested without touching a single Chrome API.

---

### Task 9: User settings and the Chrome storage repository

**Files:**
- Create: `src/domain/settings/userSettings.ts`
- Create: `src/infrastructure/storage/storageRepository.ts`, `src/infrastructure/storage/chromeStorageRepository.ts`
- Test: `src/infrastructure/storage/chromeStorageRepository.test.ts`

**Interfaces:**
- Consumes: `StudySession` from `../../domain/session/sessionTypes` (Task 2), `HardBlockCredential` from `../../domain/sites/hardBlockCredential` (Task 6).
- Produces: `TrackingTier`, `UserSettings`, `DEFAULT_USER_SETTINGS` (from `domain/settings/userSettings.ts`); `SettingsRepository` interface and `ChromeStorageRepository` implementation with `getSettings`, `saveSettings`, `getActiveSession`, `saveActiveSession`, `getHardBlockCredential`, `saveHardBlockCredential`. Consumed by `messageRouter.ts`, `alarmHandlers.ts`, `tabHandlers.ts` (Task 13), and `shared/messages.ts` (Task 11, for the `UserSettings` payload type).

- [ ] **Step 1: Write `UserSettings`**

```ts
// src/domain/settings/userSettings.ts
export type TrackingTier = "activity-only" | "detailed";

export interface UserSettings {
  pressureProfileId: string;
  trackingTier: TrackingTier;
  defaultFocusDurationSeconds: number;
  defaultBreakDurationSeconds: number;
  defaultAllowedSites: string[];
  defaultRestrictedSites: string[];
  defaultRestrictionMode: "soft" | "hard";
  onboardingCompleted: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  pressureProfileId: "strict-coach",
  trackingTier: "activity-only",
  defaultFocusDurationSeconds: 1500,
  defaultBreakDurationSeconds: 300,
  defaultAllowedSites: [],
  defaultRestrictedSites: [],
  defaultRestrictionMode: "soft",
  onboardingCompleted: false,
};
```

- [ ] **Step 2: Write the failing tests for the Chrome storage repository**

Uses WXT's `fakeBrowser` (from `wxt/testing`), which backs the global `chrome` object with an in-memory implementation — reset it between tests so state doesn't leak.

```ts
// src/infrastructure/storage/chromeStorageRepository.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { ChromeStorageRepository } from "./chromeStorageRepository";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";
import { createHardBlockCredential } from "../../domain/sites/hardBlockCredential";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("ChromeStorageRepository", () => {
  const repo = new ChromeStorageRepository();

  it("returns default settings when none are saved", async () => {
    expect(await repo.getSettings()).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("saves and retrieves settings", async () => {
    const settings = { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true };
    await repo.saveSettings(settings);
    expect(await repo.getSettings()).toEqual(settings);
  });

  it("returns null when there is no active session", async () => {
    expect(await repo.getActiveSession()).toBeNull();
  });

  it("saves and retrieves the active session", async () => {
    const input: CreateSessionInput = {
      goal: "Read chapters 3 and 4",
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "strict-coach",
      allowedSites: [],
      restrictedSites: [],
      restrictionMode: "soft",
    };
    const session = machine.createSession(input, "session_1", 0);
    await repo.saveActiveSession(session);
    expect(await repo.getActiveSession()).toEqual(session);
  });

  it("clears the active session when saved as null", async () => {
    const input: CreateSessionInput = {
      goal: "Read chapters 3 and 4",
      focusDurationSeconds: 1500,
      breakDurationSeconds: 300,
      pressureProfileId: "strict-coach",
      allowedSites: [],
      restrictedSites: [],
      restrictionMode: "soft",
    };
    const session = machine.createSession(input, "session_1", 0);
    await repo.saveActiveSession(session);
    await repo.saveActiveSession(null);
    expect(await repo.getActiveSession()).toBeNull();
  });

  it("saves and retrieves the hard-block credential", async () => {
    const credential = await createHardBlockCredential("1234");
    await repo.saveHardBlockCredential(credential);
    expect(await repo.getHardBlockCredential()).toEqual(credential);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- chromeStorageRepository --run`
Expected: FAIL — `ChromeStorageRepository` does not exist. If the failure is instead `Cannot find module 'wxt/testing'`, run `npm install -D wxt` was already satisfied by Task 1's `wxt@latest init`; if the export is missing, check the installed WXT version exposes `fakeBrowser` from `wxt/testing` and upgrade WXT if not.

- [ ] **Step 4: Write the implementation**

```ts
// src/infrastructure/storage/storageRepository.ts
import type { StudySession } from "../../domain/session/sessionTypes";
import type { UserSettings } from "../../domain/settings/userSettings";
import type { HardBlockCredential } from "../../domain/sites/hardBlockCredential";

export interface SettingsRepository {
  getSettings(): Promise<UserSettings>;
  saveSettings(settings: UserSettings): Promise<void>;
  getActiveSession(): Promise<StudySession | null>;
  saveActiveSession(session: StudySession | null): Promise<void>;
  getHardBlockCredential(): Promise<HardBlockCredential | null>;
  saveHardBlockCredential(credential: HardBlockCredential | null): Promise<void>;
}
```

```ts
// src/infrastructure/storage/chromeStorageRepository.ts
import type { SettingsRepository } from "./storageRepository";
import type { UserSettings } from "../../domain/settings/userSettings";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import type { StudySession } from "../../domain/session/sessionTypes";
import type { HardBlockCredential } from "../../domain/sites/hardBlockCredential";

const KEYS = {
  settings: "snufflestudy.settings",
  activeSession: "snufflestudy.activeSession",
  hardBlockCredential: "snufflestudy.hardBlockCredential",
} as const;

export class ChromeStorageRepository implements SettingsRepository {
  async getSettings(): Promise<UserSettings> {
    const result = await chrome.storage.local.get(KEYS.settings);
    return result[KEYS.settings] ?? DEFAULT_USER_SETTINGS;
  }

  async saveSettings(settings: UserSettings): Promise<void> {
    await chrome.storage.local.set({ [KEYS.settings]: settings });
  }

  async getActiveSession(): Promise<StudySession | null> {
    const result = await chrome.storage.local.get(KEYS.activeSession);
    return result[KEYS.activeSession] ?? null;
  }

  async saveActiveSession(session: StudySession | null): Promise<void> {
    if (session === null) {
      await chrome.storage.local.remove(KEYS.activeSession);
      return;
    }
    await chrome.storage.local.set({ [KEYS.activeSession]: session });
  }

  async getHardBlockCredential(): Promise<HardBlockCredential | null> {
    const result = await chrome.storage.local.get(KEYS.hardBlockCredential);
    return result[KEYS.hardBlockCredential] ?? null;
  }

  async saveHardBlockCredential(credential: HardBlockCredential | null): Promise<void> {
    if (credential === null) {
      await chrome.storage.local.remove(KEYS.hardBlockCredential);
      return;
    }
    await chrome.storage.local.set({ [KEYS.hardBlockCredential]: credential });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- chromeStorageRepository --run`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/domain/settings/userSettings.ts src/infrastructure/storage/storageRepository.ts src/infrastructure/storage/chromeStorageRepository.ts src/infrastructure/storage/chromeStorageRepository.test.ts
git commit -m "feat: add user settings and Chrome storage repository"
```

---

### Task 10: IndexedDB session history repository

**Files:**
- Create: `src/infrastructure/storage/indexedDbRepository.ts`
- Test: `src/infrastructure/storage/indexedDbRepository.test.ts`

**Interfaces:**
- Consumes: `StudySession`, `SessionEvent`, `HistoryQuery` from `../../domain/session/sessionTypes` (Task 2).
- Produces: `SessionRepository` interface, `IndexedDbSessionRepository` with `archive`, `listHistory`, `recordEvent`, `listEvents`. Consumed by `messageRouter.ts` and `alarmHandlers.ts` (Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// src/infrastructure/storage/indexedDbRepository.test.ts
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDbSessionRepository } from "./indexedDbRepository";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";

function buildSession(id: string, createdAt: number, state: "COMPLETED" | "ABANDONED" = "COMPLETED") {
  const input: CreateSessionInput = {
    goal: `Goal for ${id}`,
    focusDurationSeconds: 1500,
    breakDurationSeconds: 300,
    pressureProfileId: "strict-coach",
    allowedSites: [],
    restrictedSites: [],
    restrictionMode: "soft",
  };
  const created = machine.createSession(input, id, createdAt);
  const started = machine.startSession(created, createdAt);
  return state === "COMPLETED"
    ? machine.completeSession(started, createdAt + 1_500_000)
    : machine.abandonSession(started, createdAt + 500_000);
}

beforeEach(() => {
  indexedDB.deleteDatabase("snufflestudy");
});

describe("IndexedDbSessionRepository", () => {
  it("archives a session and retrieves it via listHistory", async () => {
    const repo = new IndexedDbSessionRepository();
    const session = buildSession("session_1", 1000);
    await repo.archive(session);

    const history = await repo.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("session_1");
  });

  it("orders history newest-first", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000));
    await repo.archive(buildSession("session_2", 2000));

    const history = await repo.listHistory();
    expect(history.map((s) => s.id)).toEqual(["session_2", "session_1"]);
  });

  it("filters history by since", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000));
    await repo.archive(buildSession("session_2", 5000));

    const history = await repo.listHistory({ since: 2000 });
    expect(history.map((s) => s.id)).toEqual(["session_2"]);
  });

  it("filters history by state", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000, "COMPLETED"));
    await repo.archive(buildSession("session_2", 2000, "ABANDONED"));

    const history = await repo.listHistory({ state: "ABANDONED" });
    expect(history.map((s) => s.id)).toEqual(["session_2"]);
  });

  it("limits history results", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000));
    await repo.archive(buildSession("session_2", 2000));
    await repo.archive(buildSession("session_3", 3000));

    const history = await repo.listHistory({ limit: 2 });
    expect(history).toHaveLength(2);
  });

  it("records and lists events for a session", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.recordEvent({
      id: "event_1",
      sessionId: "session_1",
      type: "DISTRACTION_ATTEMPT",
      occurredAt: 1500,
      hostname: "youtube.com",
    });
    await repo.recordEvent({
      id: "event_2",
      sessionId: "session_2",
      type: "SESSION_COMPLETED",
      occurredAt: 2000,
    });

    const events = await repo.listEvents("session_1");
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("event_1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- indexedDbRepository --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/infrastructure/storage/indexedDbRepository.ts
import { openDB, type IDBPDatabase } from "idb";
import type { StudySession, SessionEvent, HistoryQuery } from "../../domain/session/sessionTypes";

const DB_NAME = "snufflestudy";
const DB_VERSION = 1;
const SESSIONS_STORE = "sessions";
const EVENTS_STORE = "events";

export interface SessionRepository {
  archive(session: StudySession): Promise<void>;
  listHistory(options?: HistoryQuery): Promise<StudySession[]>;
  recordEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string): Promise<SessionEvent[]>;
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const store = db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
        store.createIndex("by-state", "state");
        store.createIndex("by-createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const store = db.createObjectStore(EVENTS_STORE, { keyPath: "id" });
        store.createIndex("by-sessionId", "sessionId");
      }
    },
  });
}

export class IndexedDbSessionRepository implements SessionRepository {
  async archive(session: StudySession): Promise<void> {
    const db = await getDb();
    await db.put(SESSIONS_STORE, session);
  }

  async listHistory(options: HistoryQuery = {}): Promise<StudySession[]> {
    const db = await getDb();
    let sessions = (await db.getAllFromIndex(SESSIONS_STORE, "by-createdAt")) as StudySession[];
    sessions = sessions.reverse();

    if (options.since !== undefined) {
      sessions = sessions.filter((s) => s.createdAt >= options.since!);
    }
    if (options.state !== undefined) {
      sessions = sessions.filter((s) => s.state === options.state);
    }
    if (options.limit !== undefined) {
      sessions = sessions.slice(0, options.limit);
    }
    return sessions;
  }

  async recordEvent(event: SessionEvent): Promise<void> {
    const db = await getDb();
    await db.put(EVENTS_STORE, event);
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    const db = await getDb();
    return db.getAllFromIndex(EVENTS_STORE, "by-sessionId", sessionId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- indexedDbRepository --run`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/storage/indexedDbRepository.ts src/infrastructure/storage/indexedDbRepository.test.ts
git commit -m "feat: add IndexedDB session history and event log repository"
```

This completes Phase 2 (storage).

---

### Task 11: Shared messages and the extension messenger

**Files:**
- Create: `src/shared/messages.ts`
- Create: `src/infrastructure/messaging/extensionMessenger.ts`
- Test: `src/infrastructure/messaging/extensionMessenger.test.ts`

**Interfaces:**
- Consumes: `CreateSessionInput` from `../domain/session/sessionTypes` (Task 2), `UserSettings` from `../domain/settings/userSettings` (Task 9).
- Produces: `ExtensionMessage` (the full v1 message union), `sendMessage<T>(message)`, `onMessage(handler)`. Consumed by every UI surface (Tasks 15–18, 20–21) and by `messageRouter.ts` (Task 13).

- [ ] **Step 1: Write `shared/messages.ts`**

```ts
// src/shared/messages.ts
import type { CreateSessionInput } from "../domain/session/sessionTypes";
import type { UserSettings } from "../domain/settings/userSettings";

export type ExtensionMessage =
  | { type: "SESSION_CREATE"; payload: CreateSessionInput }
  | { type: "SESSION_START"; payload: { sessionId: string } }
  | { type: "SESSION_PAUSE"; payload: { sessionId: string } }
  | { type: "SESSION_RESUME"; payload: { sessionId: string } }
  | { type: "SESSION_START_BREAK"; payload: { sessionId: string } }
  | { type: "SESSION_END_BREAK"; payload: { sessionId: string } }
  | { type: "SESSION_END"; payload: { sessionId: string; reason?: string } }
  | { type: "SESSION_GET_ACTIVE" }
  | { type: "SITE_STATUS_REQUEST"; payload: { hostname: string | null } }
  | { type: "DISTRACTION_ATTEMPT"; payload: { sessionId: string; hostname: string } }
  | { type: "MARK_SITE_STUDY_RELATED"; payload: { sessionId: string; hostname: string } }
  | { type: "HARD_BLOCK_SET_PASSCODE"; payload: { passcode: string } }
  | { type: "HARD_BLOCK_VERIFY_PASSCODE"; payload: { passcode: string; hostname: string } }
  | { type: "SETTINGS_GET" }
  | { type: "SETTINGS_SAVE"; payload: UserSettings };
```

This is a v1 subset of the arch overview's full-product `ExtensionMessage` union — `FRIEND_NUDGE` and anything accountability-related is left out on purpose (see Scope) and gets added back when that phase starts.

- [ ] **Step 2: Write the failing test**

```ts
// src/infrastructure/messaging/extensionMessenger.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { sendMessage, onMessage } from "./extensionMessenger";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("extensionMessenger", () => {
  it("delivers a message from sendMessage to a registered handler and returns its response", async () => {
    onMessage(async (message) => {
      if (message.type === "SESSION_GET_ACTIVE") {
        return { ok: true, session: null };
      }
      return { ok: false };
    });

    const response = await sendMessage<{ ok: boolean; session: null }>({ type: "SESSION_GET_ACTIVE" });
    expect(response).toEqual({ ok: true, session: null });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- extensionMessenger --run`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Write the implementation**

```ts
// src/infrastructure/messaging/extensionMessenger.ts
import type { ExtensionMessage } from "../../shared/messages";

export async function sendMessage<T = unknown>(message: ExtensionMessage): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

export type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
) => Promise<unknown> | unknown;

export function onMessage(handler: MessageHandler): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = handler(message as ExtensionMessage, sender);
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true;
    }
    sendResponse(result);
    return false;
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- extensionMessenger --run`
Expected: PASS (1 test)

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts src/infrastructure/messaging/extensionMessenger.ts src/infrastructure/messaging/extensionMessenger.test.ts
git commit -m "feat: add typed extension messages and messenger"
```

---

### Task 12: Browser API wrappers

**Files:**
- Create: `src/infrastructure/browser/tabsApi.ts`, `alarmsApi.ts`, `notificationsApi.ts`, `declarativeNetRequestApi.ts`, `permissionsApi.ts`
- Test: `src/infrastructure/browser/alarmsApi.test.ts`, `src/infrastructure/browser/permissionsApi.test.ts`

**Interfaces:**
- Produces: `getActiveTabHostname()`, `scheduleSessionAlarm(whenEpochMs)`, `cancelSessionAlarm()`, `isSessionAlarm(alarm)`, `showNotification(id, title, message)`, `syncHardBlockRules(hostnames)`, `clearHardBlockRules()`, `hasDetailedTrackingPermission()`, `requestDetailedTrackingPermission()`, `revokeDetailedTrackingPermission()`, `requestHardBlockHostPermission(hostname)`. Consumed by `messageRouter.ts`, `alarmHandlers.ts`, `tabHandlers.ts` (Task 13), `OptionsApp` (Task 18), `OnboardingWizard` (Task 16).

Not every wrapper needs its own test file — `tabsApi.ts`, `notificationsApi.ts`, and `declarativeNetRequestApi.ts` are exercised indirectly through Task 13's integration tests (mocking every thin wrapper individually would just restate the Chrome API). `alarmsApi.ts` and `permissionsApi.ts` get direct tests here because their correctness (exact alarm name, exact permission shape) matters on its own and is cheap to verify against `fakeBrowser`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/infrastructure/browser/alarmsApi.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { scheduleSessionAlarm, cancelSessionAlarm, isSessionAlarm } from "./alarmsApi";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("alarmsApi", () => {
  it("schedules an alarm at the given timestamp", async () => {
    scheduleSessionAlarm(50_000);
    const alarm = await chrome.alarms.get("snufflestudy-session-timer");
    expect(alarm?.scheduledTime).toBe(50_000);
  });

  it("cancels the session alarm", async () => {
    scheduleSessionAlarm(50_000);
    cancelSessionAlarm();
    const alarm = await chrome.alarms.get("snufflestudy-session-timer");
    expect(alarm).toBeUndefined();
  });

  it("identifies the session alarm by name", () => {
    expect(isSessionAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm)).toBe(true);
    expect(isSessionAlarm({ name: "something-else" } as chrome.alarms.Alarm)).toBe(false);
  });
});
```

```ts
// src/infrastructure/browser/permissionsApi.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import {
  hasDetailedTrackingPermission,
  requestDetailedTrackingPermission,
  revokeDetailedTrackingPermission,
} from "./permissionsApi";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("permissionsApi", () => {
  it("reports no detailed tracking permission by default", async () => {
    expect(await hasDetailedTrackingPermission()).toBe(false);
  });

  it("grants and then reports detailed tracking permission", async () => {
    await requestDetailedTrackingPermission();
    expect(await hasDetailedTrackingPermission()).toBe(true);
  });

  it("revokes detailed tracking permission", async () => {
    await requestDetailedTrackingPermission();
    await revokeDetailedTrackingPermission();
    expect(await hasDetailedTrackingPermission()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- alarmsApi permissionsApi --run`
Expected: FAIL — neither module exists yet.

- [ ] **Step 3: Write the implementations**

```ts
// src/infrastructure/browser/alarmsApi.ts
const SESSION_ALARM = "snufflestudy-session-timer";

export function scheduleSessionAlarm(whenEpochMs: number): void {
  chrome.alarms.create(SESSION_ALARM, { when: whenEpochMs });
}

export function cancelSessionAlarm(): void {
  chrome.alarms.clear(SESSION_ALARM);
}

export function isSessionAlarm(alarm: chrome.alarms.Alarm): boolean {
  return alarm.name === SESSION_ALARM;
}
```

```ts
// src/infrastructure/browser/tabsApi.ts
export async function getActiveTabHostname(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    return new URL(tab.url).hostname;
  } catch {
    return null;
  }
}
```

```ts
// src/infrastructure/browser/notificationsApi.ts
export function showNotification(id: string, title: string, message: string): void {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "/icons/128.png",
    title,
    message,
  });
}
```

```ts
// src/infrastructure/browser/permissionsApi.ts
export async function hasDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ["*://*/*"] });
}

export async function requestDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: ["*://*/*"] });
}

export async function revokeDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.remove({ origins: ["*://*/*"] });
}

export async function requestHardBlockHostPermission(hostname: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [`*://${hostname}/*`, `*://*.${hostname}/*`] });
}
```

```ts
// src/infrastructure/browser/declarativeNetRequestApi.ts
const RULE_ID_BASE = 1000;

export async function syncHardBlockRules(hardRestrictedHostnames: string[]): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingIds = existing.map((rule) => rule.id);

  const newRules: chrome.declarativeNetRequest.Rule[] = hardRestrictedHostnames.map(
    (hostname, index) => ({
      id: RULE_ID_BASE + index,
      priority: 1,
      action: {
        type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
        redirect: { extensionPath: `/locked.html?site=${encodeURIComponent(hostname)}` },
      },
      condition: {
        requestDomains: [hostname],
        resourceTypes: ["main_frame" as chrome.declarativeNetRequest.ResourceType],
      },
    })
  );

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingIds,
    addRules: newRules,
  });
}

export async function clearHardBlockRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
  });
}
```

If `fakeBrowser` doesn't implement `chrome.declarativeNetRequest` (coverage varies by WXT version), Task 13's integration test for hard-mode session start stubs it directly with `vi.stubGlobal("chrome", { ...chrome, declarativeNetRequest: { getDynamicRules: vi.fn().mockResolvedValue([]), updateDynamicRules: vi.fn().mockResolvedValue(undefined) } })` rather than leaving that path untested.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- alarmsApi permissionsApi --run`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/browser/
git commit -m "feat: add thin browser API wrappers for alarms, tabs, notifications, declarativeNetRequest, and permissions"
```

---

### Task 13: Background service worker wiring

**Files:**
- Create: `src/background/messageRouter.ts`, `src/background/alarmHandlers.ts`, `src/background/tabHandlers.ts`, `src/background/index.ts`
- Test: `src/background/messageRouter.test.ts`, `src/background/alarmHandlers.test.ts`, `src/background/tabHandlers.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–12 — this is the task that wires domain + storage + messaging + browser APIs into a running engine.
- Produces: `handleMessage(message)` (exported for testing and used by `onMessage` in `index.ts`), `handleAlarm(alarm)` and `registerAlarmHandlers()`, `handleTabUpdate(tabId, changeInfo)` and `registerTabHandlers()`. This is the last task before the extension can run a full session end-to-end.

`handleAlarm` and `handleTabUpdate` are exported separately from their `register*` functions specifically so tests can call them directly instead of trying to trigger a real `chrome.alarms.onAlarm` / `chrome.tabs.onUpdated` event through `fakeBrowser`.

- [ ] **Step 1: Write `messageRouter.ts`**

```ts
// src/background/messageRouter.ts
import type { ExtensionMessage } from "../shared/messages";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import * as machine from "../domain/session/sessionMachine";
import { validateCreateSessionInput } from "../domain/session/sessionValidation";
import { classifySite } from "../domain/sites/siteRules";
import { createHardBlockCredential, verifyPasscode } from "../domain/sites/hardBlockCredential";
import { scheduleSessionAlarm, cancelSessionAlarm } from "../infrastructure/browser/alarmsApi";
import { syncHardBlockRules, clearHardBlockRules } from "../infrastructure/browser/declarativeNetRequestApi";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();

function newId(): string {
  return crypto.randomUUID();
}

async function requireActiveSession(sessionId: string) {
  const session = await settingsRepo.getActiveSession();
  if (!session || session.id !== sessionId) {
    throw new Error(`No active session with id ${sessionId}`);
  }
  return session;
}

export async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  const now = Date.now();

  switch (message.type) {
    case "SESSION_CREATE": {
      const validation = validateCreateSessionInput(message.payload);
      if (!validation.valid) return { ok: false, errors: validation.errors };
      const session = machine.createSession(message.payload, newId(), now);
      await settingsRepo.saveActiveSession(session);
      return { ok: true, session };
    }

    case "SESSION_START": {
      const session = await requireActiveSession(message.payload.sessionId);
      const started = machine.startSession(session, now);
      await settingsRepo.saveActiveSession(started);
      scheduleSessionAlarm(started.plannedEndAt!);
      if (started.restrictionMode === "hard") {
        await syncHardBlockRules(started.restrictedSites);
      }
      return { ok: true, session: started };
    }

    case "SESSION_PAUSE": {
      const session = await requireActiveSession(message.payload.sessionId);
      const paused = machine.pauseSession(session, now);
      await settingsRepo.saveActiveSession(paused);
      cancelSessionAlarm();
      return { ok: true, session: paused };
    }

    case "SESSION_RESUME": {
      const session = await requireActiveSession(message.payload.sessionId);
      const resumed = machine.resumeSession(session, now);
      await settingsRepo.saveActiveSession(resumed);
      scheduleSessionAlarm(resumed.plannedEndAt!);
      return { ok: true, session: resumed };
    }

    case "SESSION_START_BREAK": {
      const session = await requireActiveSession(message.payload.sessionId);
      const onBreak = machine.startBreak(session, now);
      await settingsRepo.saveActiveSession(onBreak);
      scheduleSessionAlarm(onBreak.breakEndsAt!);
      return { ok: true, session: onBreak };
    }

    case "SESSION_END_BREAK": {
      const session = await requireActiveSession(message.payload.sessionId);
      const focusing = machine.endBreak(session, now);
      await settingsRepo.saveActiveSession(focusing);
      scheduleSessionAlarm(focusing.plannedEndAt!);
      return { ok: true, session: focusing };
    }

    case "SESSION_END": {
      const session = await requireActiveSession(message.payload.sessionId);
      const ended =
        session.state === "FOCUSING"
          ? machine.completeSession(session, now)
          : machine.abandonSession(session, now);
      await historyRepo.archive(ended);
      await settingsRepo.saveActiveSession(null);
      cancelSessionAlarm();
      await clearHardBlockRules();
      return { ok: true, session: ended };
    }

    case "SESSION_GET_ACTIVE": {
      return { ok: true, session: await settingsRepo.getActiveSession() };
    }

    case "SITE_STATUS_REQUEST": {
      const session = await settingsRepo.getActiveSession();
      if (!session) return { ok: true, classification: "UNKNOWN" };
      return { ok: true, classification: classifySite(session, message.payload.hostname) };
    }

    case "DISTRACTION_ATTEMPT": {
      const session = await requireActiveSession(message.payload.sessionId);
      const updated = machine.recordDistractionAttempt(machine.warnSession(session));
      await settingsRepo.saveActiveSession(updated);
      await historyRepo.recordEvent({
        id: newId(),
        sessionId: session.id,
        type: "DISTRACTION_ATTEMPT",
        occurredAt: now,
        hostname: message.payload.hostname,
      });
      return { ok: true, session: updated };
    }

    case "MARK_SITE_STUDY_RELATED": {
      const session = await requireActiveSession(message.payload.sessionId);
      const updated = { ...session, allowedSites: [...session.allowedSites, message.payload.hostname] };
      await settingsRepo.saveActiveSession(updated);
      await historyRepo.recordEvent({
        id: newId(),
        sessionId: session.id,
        type: "SITE_MARKED_STUDY_RELATED",
        occurredAt: now,
        hostname: message.payload.hostname,
      });
      return { ok: true, session: updated };
    }

    case "HARD_BLOCK_SET_PASSCODE": {
      const credential = await createHardBlockCredential(message.payload.passcode);
      await settingsRepo.saveHardBlockCredential(credential);
      return { ok: true };
    }

    case "HARD_BLOCK_VERIFY_PASSCODE": {
      const credential = await settingsRepo.getHardBlockCredential();
      if (!credential) return { ok: false, error: "No passcode configured." };
      const result = await verifyPasscode(credential, message.payload.passcode, now);
      await settingsRepo.saveHardBlockCredential(result.credential);
      return { ok: result.success };
    }

    case "SETTINGS_GET": {
      return { ok: true, settings: await settingsRepo.getSettings() };
    }

    case "SETTINGS_SAVE": {
      await settingsRepo.saveSettings(message.payload);
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type" };
  }
}
```

- [ ] **Step 2: Write the failing integration test for the happy path**

```ts
// src/background/messageRouter.test.ts
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { handleMessage } from "./messageRouter";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

beforeEach(() => {
  fakeBrowser.reset();
  indexedDB.deleteDatabase("snufflestudy");
});

const createInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
};

describe("messageRouter — full session lifecycle", () => {
  it("creates, starts, pauses, resumes, and ends a session", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      ok: boolean;
      session: { id: string; state: string };
    };
    expect(created.ok).toBe(true);
    expect(created.session.state).toBe("SESSION_SETUP");

    const sessionId = created.session.id;

    const started = (await handleMessage({ type: "SESSION_START", payload: { sessionId } })) as {
      session: { state: string };
    };
    expect(started.session.state).toBe("FOCUSING");

    const alarm = await chrome.alarms.get("snufflestudy-session-timer");
    expect(alarm).toBeDefined();

    const paused = (await handleMessage({ type: "SESSION_PAUSE", payload: { sessionId } })) as {
      session: { state: string };
    };
    expect(paused.session.state).toBe("PAUSED");
    expect(await chrome.alarms.get("snufflestudy-session-timer")).toBeUndefined();

    const resumed = (await handleMessage({ type: "SESSION_RESUME", payload: { sessionId } })) as {
      session: { state: string };
    };
    expect(resumed.session.state).toBe("FOCUSING");

    const ended = (await handleMessage({
      type: "SESSION_END",
      payload: { sessionId },
    })) as { session: { state: string } };
    expect(ended.session.state).toBe("ABANDONED");

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).toBeNull();
  });

  it("rejects an invalid SESSION_CREATE with validation errors", async () => {
    const result = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, goal: "" },
    })) as { ok: boolean; errors: string[] };
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Goal cannot be empty.");
  });

  it("records a distraction attempt and updates the active session", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    const result = (await handleMessage({
      type: "DISTRACTION_ATTEMPT",
      payload: { sessionId: created.session.id, hostname: "youtube.com" },
    })) as { session: { distractionAttempts: number; interventionLevel: string } };

    expect(result.session.distractionAttempts).toBe(1);
    expect(result.session.interventionLevel).toBe("warned");
  });

  it("sets and verifies a hard-block passcode", async () => {
    await handleMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode: "1234" } });

    const wrong = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "0000", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(wrong.ok).toBe(false);

    const right = (await handleMessage({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode: "1234", hostname: "youtube.com" },
    })) as { ok: boolean };
    expect(right.ok).toBe(true);
  });

  it("saves and retrieves settings", async () => {
    const initial = (await handleMessage({ type: "SETTINGS_GET" })) as {
      settings: { onboardingCompleted: boolean };
    };
    expect(initial.settings.onboardingCompleted).toBe(false);

    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: { ...initial.settings, onboardingCompleted: true },
    });

    const updated = (await handleMessage({ type: "SETTINGS_GET" })) as {
      settings: { onboardingCompleted: boolean };
    };
    expect(updated.settings.onboardingCompleted).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail, then pass**

Run: `npm test -- messageRouter --run`
Expected: first run FAILs if `messageRouter.ts` isn't saved yet; after Step 1's file is in place, PASS (5 tests). If `chrome.declarativeNetRequest` is undefined under `fakeBrowser` and a hard-mode test is added later, apply the `vi.stubGlobal` fallback noted in Task 12.

- [ ] **Step 4: Write `alarmHandlers.ts` and its test**

```ts
// src/background/alarmHandlers.ts
import { isSessionAlarm } from "../infrastructure/browser/alarmsApi";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import * as machine from "../domain/session/sessionMachine";
import { showNotification } from "../infrastructure/browser/notificationsApi";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();

export async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (!isSessionAlarm(alarm)) return;

  const session = await settingsRepo.getActiveSession();
  if (!session) return;

  const now = Date.now();

  if (session.state === "FOCUSING") {
    const completed = machine.completeSession(session, now);
    await historyRepo.archive(completed);
    await settingsRepo.saveActiveSession(null);
    showNotification("session-complete", "Goal complete", `"${session.goal}" is done. Nice work.`);
    return;
  }

  if (session.state === "BREAK") {
    const focusing = machine.endBreak(session, now);
    await settingsRepo.saveActiveSession(focusing);
    showNotification("break-over", "Break's over", "Back to it.");
  }
}

export function registerAlarmHandlers(): void {
  chrome.alarms.onAlarm.addListener(handleAlarm);
}
```

```ts
// src/background/alarmHandlers.test.ts
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { handleAlarm } from "./alarmHandlers";
import { handleMessage } from "./messageRouter";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

beforeEach(() => {
  fakeBrowser.reset();
  indexedDB.deleteDatabase("snufflestudy");
});

const createInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("handleAlarm", () => {
  it("auto-completes a FOCUSING session and archives it", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).toBeNull();
  });

  it("ignores alarms that aren't the session alarm", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleAlarm({ name: "some-other-alarm" } as chrome.alarms.Alarm);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as { session: unknown };
    expect(active.session).not.toBeNull();
  });

  it("transitions a BREAK session back to FOCUSING", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    const { session } = (await handleMessage({
      type: "SESSION_START",
      payload: { sessionId: created.session.id },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START_BREAK", payload: { sessionId: session.id } });

    await handleAlarm({ name: "snufflestudy-session-timer" } as chrome.alarms.Alarm);

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { state: string };
    };
    expect(active.session.state).toBe("FOCUSING");
  });
});
```

Run: `npm test -- alarmHandlers --run`
Expected: PASS (3 tests)

- [ ] **Step 5: Write `tabHandlers.ts` and its test**

```ts
// src/background/tabHandlers.ts
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import { classifySite, restrictionModeFor } from "../domain/sites/siteRules";
import * as machine from "../domain/session/sessionMachine";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();

function hostnameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export async function handleTabUpdate(changeInfo: chrome.tabs.TabChangeInfo): Promise<void> {
  if (changeInfo.status !== "complete") return;

  const settings = await settingsRepo.getSettings();
  if (settings.trackingTier !== "detailed") return;

  const session = await settingsRepo.getActiveSession();
  if (!session || session.state !== "FOCUSING") return;

  const hostname = hostnameFromUrl(changeInfo.url);
  const classification = classifySite(session, hostname);
  if (classification !== "BLOCKED" || hostname === null) return;

  const mode = restrictionModeFor(session, hostname);
  if (mode === "hard") return; // declarativeNetRequest already redirected this navigation

  const updated = machine.recordDistractionAttempt(machine.warnSession(session));
  await settingsRepo.saveActiveSession(updated);
  await historyRepo.recordEvent({
    id: crypto.randomUUID(),
    sessionId: session.id,
    type: "DISTRACTION_ATTEMPT",
    occurredAt: Date.now(),
    hostname,
  });
}

export function registerTabHandlers(): void {
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    void handleTabUpdate(changeInfo);
  });
}
```

```ts
// src/background/tabHandlers.test.ts
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { handleTabUpdate } from "./tabHandlers";
import { handleMessage } from "./messageRouter";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

beforeEach(() => {
  fakeBrowser.reset();
  indexedDB.deleteDatabase("snufflestudy");
});

const createInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
};

describe("handleTabUpdate", () => {
  it("does nothing when the tracking tier is activity-only", async () => {
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleTabUpdate({ status: "complete", url: "https://youtube.com/watch" });

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number };
    };
    expect(active.session.distractionAttempts).toBe(0);
  });

  it("records a distraction attempt for a soft-restricted site when tracking is detailed", async () => {
    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: {
        pressureProfileId: "strict-coach",
        trackingTier: "detailed",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });
    const created = (await handleMessage({ type: "SESSION_CREATE", payload: createInput })) as {
      session: { id: string };
    };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleTabUpdate({ status: "complete", url: "https://youtube.com/watch" });

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number; interventionLevel: string };
    };
    expect(active.session.distractionAttempts).toBe(1);
    expect(active.session.interventionLevel).toBe("warned");
  });

  it("ignores an allowed site", async () => {
    await handleMessage({
      type: "SETTINGS_SAVE",
      payload: {
        pressureProfileId: "strict-coach",
        trackingTier: "detailed",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });
    const created = (await handleMessage({
      type: "SESSION_CREATE",
      payload: { ...createInput, allowedSites: ["docs.google.com"] },
    })) as { session: { id: string } };
    await handleMessage({ type: "SESSION_START", payload: { sessionId: created.session.id } });

    await handleTabUpdate({ status: "complete", url: "https://docs.google.com/doc/1" });

    const active = (await handleMessage({ type: "SESSION_GET_ACTIVE" })) as {
      session: { distractionAttempts: number };
    };
    expect(active.session.distractionAttempts).toBe(0);
  });
});
```

Run: `npm test -- tabHandlers --run`
Expected: PASS (3 tests)

- [ ] **Step 6: Write `background/index.ts`**

```ts
// src/background/index.ts
import { onMessage } from "../infrastructure/messaging/extensionMessenger";
import { handleMessage } from "./messageRouter";
import { registerAlarmHandlers } from "./alarmHandlers";
import { registerTabHandlers } from "./tabHandlers";

export default defineBackground(() => {
  onMessage(handleMessage);
  registerAlarmHandlers();
  registerTabHandlers();
});
```

`defineBackground` is WXT's entry-point helper (auto-imported by the WXT compiler; no explicit import needed, matching the pattern WXT's `init -t react` template scaffolds for `entrypoints/background.ts`). If Task 1's scaffold placed the background entry point somewhere other than `src/background/index.ts` (WXT's default is `entrypoints/background.ts`), move this file's contents there and re-export the rest of `src/background/` as plain modules — the logic doesn't change, only which file WXT treats as the entry point.

- [ ] **Step 7: Run the full test suite**

Run: `npm test -- --run`
Expected: PASS — every test file from Tasks 2–13 passes together (no shared mutable state leaking between them, since every test file resets `fakeBrowser` and deletes the IndexedDB database in `beforeEach`).

- [ ] **Step 8: Commit**

```bash
git add src/background/
git commit -m "feat: wire domain, storage, and messaging into the background service worker"
```

This completes Phase 3. The extension now has a fully working session engine reachable by message — only UI is missing.

---

### Task 14: Shared UI components

**Files:**
- Create: `src/shared/ui/TimerRing.tsx`, `src/shared/ui/SessionStatusCard.tsx`
- Test: `src/shared/ui/TimerRing.test.tsx`, `src/shared/ui/SessionStatusCard.test.tsx`

**Interfaces:**
- Consumes: `StudySession` from `../../domain/session/sessionTypes` (Task 2).
- Produces: `<TimerRing remainingSeconds totalSeconds />`, `<SessionStatusCard session />`. Consumed by `PopupApp` (Task 15) and `SidePanelApp` (Task 17) — the one deliberate duplication point between those two surfaces, per the "component granularity" guidance in the arch overview's Presentation layer section.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/shared/ui/TimerRing.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimerRing } from "./TimerRing";

describe("TimerRing", () => {
  it("renders minutes and seconds, zero-padded", () => {
    render(<TimerRing remainingSeconds={125} totalSeconds={1500} />);
    expect(screen.getByRole("timer")).toHaveTextContent("2:05");
  });

  it("renders 0:00 when time has run out", () => {
    render(<TimerRing remainingSeconds={0} totalSeconds={1500} />);
    expect(screen.getByRole("timer")).toHaveTextContent("0:00");
  });
});
```

```tsx
// src/shared/ui/SessionStatusCard.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionStatusCard } from "./SessionStatusCard";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("SessionStatusCard", () => {
  it("shows the goal and state", () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    render(<SessionStatusCard session={session} />);
    expect(screen.getByText("Finish 20 chemistry problems")).toBeInTheDocument();
    expect(screen.getByText("FOCUSING")).toBeInTheDocument();
  });

  it("hides the distraction count when there are none", () => {
    const session = machine.createSession(input, "session_1", 0);
    render(<SessionStatusCard session={session} />);
    expect(screen.queryByText(/distraction attempt/)).not.toBeInTheDocument();
  });

  it("shows a pluralized distraction count when there are some", () => {
    const session = machine.recordDistractionAttempt(machine.createSession(input, "session_1", 0));
    render(<SessionStatusCard session={session} />);
    expect(screen.getByText("1 distraction attempt")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- TimerRing SessionStatusCard --run`
Expected: FAIL — neither component exists yet.

- [ ] **Step 3: Write the implementations**

```tsx
// src/shared/ui/TimerRing.tsx
interface TimerRingProps {
  remainingSeconds: number;
  totalSeconds: number;
}

export function TimerRing({ remainingSeconds, totalSeconds }: TimerRingProps) {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const progress = totalSeconds > 0 ? remainingSeconds / totalSeconds : 0;

  return (
    <div className="timer-ring" role="timer" aria-live="polite">
      <svg viewBox="0 0 100 100" width="120" height="120">
        <circle cx="50" cy="50" r="45" className="timer-ring__track" />
        <circle
          cx="50"
          cy="50"
          r="45"
          className="timer-ring__progress"
          style={{ strokeDasharray: `${progress * 283} 283` }}
        />
      </svg>
      <span className="timer-ring__label">
        {minutes}:{seconds.toString().padStart(2, "0")}
      </span>
    </div>
  );
}
```

```tsx
// src/shared/ui/SessionStatusCard.tsx
import type { StudySession } from "../../domain/session/sessionTypes";

interface SessionStatusCardProps {
  session: StudySession;
}

export function SessionStatusCard({ session }: SessionStatusCardProps) {
  return (
    <div className="session-status-card">
      <p className="session-status-card__goal">{session.goal}</p>
      <p className="session-status-card__state">{session.state}</p>
      {session.distractionAttempts > 0 && (
        <p className="session-status-card__distractions">
          {session.distractionAttempts} distraction attempt
          {session.distractionAttempts === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- TimerRing SessionStatusCard --run`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/ui/
git commit -m "feat: add shared TimerRing and SessionStatusCard components"
```

---

### Task 15: Popup app

**Files:**
- Create: `src/popup/hooks/useActiveSession.ts`, `src/popup/PopupApp.tsx`
- Test: `src/popup/PopupApp.test.tsx`

**Interfaces:**
- Consumes: `sendMessage` from `../infrastructure/messaging/extensionMessenger` (Task 11), `remainingSeconds` from `../domain/session/timer` (Task 4), `TimerRing`/`SessionStatusCard` (Task 14).
- Produces: `useActiveSession()` hook (also reused by `SidePanelApp`, Task 17), `<PopupApp />` as the popup entry point.

- [ ] **Step 1: Write `useActiveSession`**

```ts
// src/popup/hooks/useActiveSession.ts
import { useEffect, useState } from "react";
import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

const ACTIVE_SESSION_KEY = "snufflestudy.activeSession";

export function useActiveSession() {
  const [session, setSession] = useState<StudySession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const response = await sendMessage<{ ok: boolean; session: StudySession | null }>({
        type: "SESSION_GET_ACTIVE",
      });
      if (!cancelled) {
        setSession(response.session);
        setLoading(false);
      }
    }

    load();

    function onStorageChange(changes: Record<string, chrome.storage.StorageChange>) {
      if (ACTIVE_SESSION_KEY in changes) {
        setSession((changes[ACTIVE_SESSION_KEY].newValue as StudySession | undefined) ?? null);
      }
    }
    chrome.storage.onChanged.addListener(onStorageChange);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, []);

  return { session, loading };
}
```

- [ ] **Step 2: Write the failing test for `PopupApp`**

```tsx
// src/popup/PopupApp.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PopupApp } from "./PopupApp";
import * as messenger from "../infrastructure/messaging/extensionMessenger";
import * as machine from "../domain/session/sessionMachine";
import type { CreateSessionInput } from "../domain/session/sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
});

describe("PopupApp", () => {
  it("shows an idle message when there is no active session", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    render(<PopupApp />);
    await waitFor(() => expect(screen.getByText("No active session.")).toBeInTheDocument());
  });

  it("shows session status and pause control while FOCUSING", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session });
    render(<PopupApp />);
    await waitFor(() => expect(screen.getByText("Finish 20 chemistry problems")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("sends SESSION_PAUSE when the Pause button is clicked", async () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session });
    render(<PopupApp />);
    await waitFor(() => screen.getByRole("button", { name: "Pause" }));

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_PAUSE",
        payload: { sessionId: "session_1" },
      })
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- PopupApp --run`
Expected: FAIL — `PopupApp` does not exist.

- [ ] **Step 4: Write `PopupApp.tsx`**

```tsx
// src/popup/PopupApp.tsx
import { useActiveSession } from "./hooks/useActiveSession";
import { TimerRing } from "../shared/ui/TimerRing";
import { SessionStatusCard } from "../shared/ui/SessionStatusCard";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import { remainingSeconds } from "../domain/session/timer";

export function PopupApp() {
  const { session, loading } = useActiveSession();

  if (loading) return <div className="popup-app">Loading…</div>;

  if (!session) {
    return (
      <div className="popup-app popup-app--idle">
        <p>No active session.</p>
        <button onClick={() => chrome.sidePanel?.open({})}>Start a session</button>
      </div>
    );
  }

  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="popup-app">
      <SessionStatusCard session={session} />
      <TimerRing remainingSeconds={remainingSeconds(session, Date.now())} totalSeconds={totalSeconds} />
      <div className="popup-app__controls">
        {session.state === "FOCUSING" && (
          <button onClick={() => sendMessage({ type: "SESSION_PAUSE", payload: { sessionId: session.id } })}>
            Pause
          </button>
        )}
        {session.state === "PAUSED" && (
          <button onClick={() => sendMessage({ type: "SESSION_RESUME", payload: { sessionId: session.id } })}>
            Resume
          </button>
        )}
        <button onClick={() => sendMessage({ type: "SESSION_END", payload: { sessionId: session.id } })}>
          End session
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- PopupApp --run`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/popup/
git commit -m "feat: add popup app with session status and controls"
```

---

### Task 16: Onboarding wizard

**Files:**
- Create: `src/app/routes/OnboardingWizard.tsx`
- Test: `src/app/routes/OnboardingWizard.test.tsx`

**Interfaces:**
- Consumes: `PRESSURE_PROFILES` from `../../domain/pressure/pressureProfiles` (Task 7), `TrackingTier` from `../../domain/settings/userSettings` (Task 9), `sendMessage` (Task 11), `requestDetailedTrackingPermission` from `../../infrastructure/browser/permissionsApi` (Task 12).
- Produces: `<OnboardingWizard onComplete={() => void} />`. Consumed by `SidePanelApp` (Task 17).

This implements onboarding steps 1–6 from the arch overview's list (name, pressure style, duration, tracking tier, sites, review) — step "optionally create or join a friend group" is skipped (out of scope, see Scope), and the passcode is deliberately **not** set here (deferred to Settings, matching the arch overview's onboarding list, which never mentions a passcode step).

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/routes/OnboardingWizard.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as permissionsApi from "../../infrastructure/browser/permissionsApi";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OnboardingWizard", () => {
  it("walks through all steps and saves settings on completion", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    const onComplete = vi.fn();

    render(<OnboardingWizard onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // name -> pressure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // pressure -> duration
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // duration -> tracking

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // tracking (activity-only default) -> review
    fireEvent.click(screen.getByRole("button", { name: "Start using SnuffleStudy" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SETTINGS_SAVE",
          payload: expect.objectContaining({ onboardingCompleted: true, trackingTier: "activity-only" }),
        })
      )
    );
    expect(onComplete).toHaveBeenCalled();
  });

  it("requests detailed tracking permission and shows the site-list step when chosen", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    vi.spyOn(permissionsApi, "requestDetailedTrackingPermission").mockResolvedValue(true);

    render(<OnboardingWizard onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByLabelText(/Detailed site tracking/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Restricted sites")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- OnboardingWizard --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```tsx
// src/app/routes/OnboardingWizard.tsx
import { useState } from "react";
import type { TrackingTier } from "../../domain/settings/userSettings";
import { PRESSURE_PROFILES } from "../../domain/pressure/pressureProfiles";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { requestDetailedTrackingPermission } from "../../infrastructure/browser/permissionsApi";

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = "name" | "pressure" | "duration" | "tracking" | "sites" | "review";

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>("name");
  const [pressureProfileId, setPressureProfileId] = useState(PRESSURE_PROFILES[0].id);
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [trackingTier, setTrackingTier] = useState<TrackingTier>("activity-only");
  const [restrictedSites, setRestrictedSites] = useState<string[]>([
    "youtube.com",
    "reddit.com",
    "tiktok.com",
  ]);

  async function finish() {
    let finalTrackingTier = trackingTier;
    if (trackingTier === "detailed") {
      const granted = await requestDetailedTrackingPermission();
      if (!granted) finalTrackingTier = "activity-only";
    }

    await sendMessage({
      type: "SETTINGS_SAVE",
      payload: {
        pressureProfileId,
        trackingTier: finalTrackingTier,
        defaultFocusDurationSeconds: focusMinutes * 60,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: finalTrackingTier === "detailed" ? restrictedSites : [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });

    onComplete();
  }

  if (step === "name") {
    return (
      <div className="onboarding-step">
        <h2>Meet Snuffles</h2>
        <p>Your study accountability companion.</p>
        <button onClick={() => setStep("pressure")}>Continue</button>
      </div>
    );
  }

  if (step === "pressure") {
    return (
      <div className="onboarding-step">
        <h2>Choose a pressure style</h2>
        <select value={pressureProfileId} onChange={(e) => setPressureProfileId(e.target.value)}>
          {PRESSURE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <button onClick={() => setStep("duration")}>Continue</button>
      </div>
    );
  }

  if (step === "duration") {
    return (
      <div className="onboarding-step">
        <h2>Default study duration</h2>
        <label>
          Minutes
          <input
            type="number"
            min={5}
            max={120}
            value={focusMinutes}
            onChange={(e) => setFocusMinutes(Number(e.target.value))}
          />
        </label>
        <button onClick={() => setStep("tracking")}>Continue</button>
      </div>
    );
  }

  if (step === "tracking") {
    return (
      <div className="onboarding-step">
        <h2>How should Snuffles track distraction?</h2>
        <label>
          <input
            type="radio"
            checked={trackingTier === "activity-only"}
            onChange={() => setTrackingTier("activity-only")}
          />
          Activity-only — no site permissions, just whether you're engaged
        </label>
        <label>
          <input
            type="radio"
            checked={trackingTier === "detailed"}
            onChange={() => setTrackingTier("detailed")}
          />
          Detailed site tracking — lets Snuffles tell allowed sites from restricted ones
        </label>
        <button onClick={() => setStep(trackingTier === "detailed" ? "sites" : "review")}>
          Continue
        </button>
      </div>
    );
  }

  if (step === "sites") {
    return (
      <div className="onboarding-step">
        <h2>Restricted sites</h2>
        <textarea
          value={restrictedSites.join("\n")}
          onChange={(e) => setRestrictedSites(e.target.value.split("\n").filter(Boolean))}
        />
        <button onClick={() => setStep("review")}>Continue</button>
      </div>
    );
  }

  return (
    <div className="onboarding-step">
      <h2>Ready to go</h2>
      <p>You can invite friends and set a hard-block passcode later in Settings.</p>
      <button onClick={finish}>Start using SnuffleStudy</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- OnboardingWizard --run`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/routes/OnboardingWizard.tsx src/app/routes/OnboardingWizard.test.tsx
git commit -m "feat: add onboarding wizard"
```

---

### Task 17: Side panel app and session setup form

**Files:**
- Create: `src/sidepanel/components/SessionSetupForm.tsx`, `src/sidepanel/SidePanelApp.tsx`
- Test: `src/sidepanel/components/SessionSetupForm.test.tsx`, `src/sidepanel/SidePanelApp.test.tsx`

**Interfaces:**
- Consumes: `OnboardingWizard` (Task 16), `useActiveSession` (Task 15), `TimerRing`/`SessionStatusCard` (Task 14), `UserSettings` (Task 9), `PRESSURE_PROFILES` (Task 7), `sendMessage` (Task 11).
- Produces: `<SessionSetupForm settings />`, `<SidePanelApp />` — the side panel entry point, gating onboarding vs. setup vs. active-session views.

- [ ] **Step 1: Write the failing test for `SessionSetupForm`**

```tsx
// src/sidepanel/components/SessionSetupForm.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionSetupForm } from "./SessionSetupForm";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SessionSetupForm", () => {
  it("creates and starts a session on submit", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValueOnce({ ok: true, session: { id: "session_1" } })
      .mockResolvedValueOnce({ ok: true });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);

    fireEvent.change(screen.getByPlaceholderText("Finish 20 chemistry problems"), {
      target: { value: "Read chapter 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: "SESSION_CREATE",
          payload: expect.objectContaining({ goal: "Read chapter 3" }),
        })
      )
    );
    expect(sendMessageSpy).toHaveBeenNthCalledWith(2, {
      type: "SESSION_START",
      payload: { sessionId: "session_1" },
    });
  });

  it("shows validation errors instead of starting a session", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValueOnce({
      ok: false,
      errors: ["Goal cannot be empty."],
    });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Goal cannot be empty."));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- SessionSetupForm --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write `SessionSetupForm.tsx`**

```tsx
// src/sidepanel/components/SessionSetupForm.tsx
import { useState, type FormEvent } from "react";
import type { UserSettings } from "../../domain/settings/userSettings";
import { PRESSURE_PROFILES } from "../../domain/pressure/pressureProfiles";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

interface SessionSetupFormProps {
  settings: UserSettings;
}

export function SessionSetupForm({ settings }: SessionSetupFormProps) {
  const [goal, setGoal] = useState("");
  const [focusMinutes, setFocusMinutes] = useState(settings.defaultFocusDurationSeconds / 60);
  const [pressureProfileId, setPressureProfileId] = useState(settings.pressureProfileId);
  const [restrictionMode, setRestrictionMode] = useState(settings.defaultRestrictionMode);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const createResponse = await sendMessage<{
      ok: boolean;
      session?: { id: string };
      errors?: string[];
    }>({
      type: "SESSION_CREATE",
      payload: {
        goal,
        focusDurationSeconds: focusMinutes * 60,
        breakDurationSeconds: settings.defaultBreakDurationSeconds,
        pressureProfileId,
        allowedSites: settings.defaultAllowedSites,
        restrictedSites: settings.defaultRestrictedSites,
        restrictionMode,
      },
    });

    if (!createResponse.ok || !createResponse.session) {
      setError(createResponse.errors?.join(" ") ?? "Could not create session.");
      return;
    }

    await sendMessage({ type: "SESSION_START", payload: { sessionId: createResponse.session.id } });
  }

  return (
    <form className="session-setup-form" onSubmit={handleSubmit}>
      <label>
        Goal
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Finish 20 chemistry problems"
        />
      </label>
      <label>
        Focus duration (minutes)
        <input
          type="number"
          min={5}
          max={180}
          value={focusMinutes}
          onChange={(e) => setFocusMinutes(Number(e.target.value))}
        />
      </label>
      <label>
        Pressure style
        <select value={pressureProfileId} onChange={(e) => setPressureProfileId(e.target.value)}>
          {PRESSURE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Restriction mode</legend>
        <label>
          <input
            type="radio"
            checked={restrictionMode === "soft"}
            onChange={() => setRestrictionMode("soft")}
          />
          Soft — nudge and escalate
        </label>
        <label>
          <input
            type="radio"
            checked={restrictionMode === "hard"}
            onChange={() => setRestrictionMode("hard")}
          />
          Hard — passcode required
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <button type="submit">Start session</button>
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- SessionSetupForm --run`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for `SidePanelApp`**

```tsx
// src/sidepanel/SidePanelApp.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SidePanelApp } from "./SidePanelApp";
import * as messenger from "../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../domain/settings/userSettings";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
});

describe("SidePanelApp", () => {
  it("shows onboarding when settings.onboardingCompleted is false", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") return { ok: true, settings: DEFAULT_USER_SETTINGS };
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() => expect(screen.getByText("Meet Snuffles")).toBeInTheDocument());
  });

  it("shows the session setup form when onboarding is complete and there is no active session", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "SETTINGS_GET") {
        return { ok: true, settings: { ...DEFAULT_USER_SETTINGS, onboardingCompleted: true } };
      }
      if (message.type === "SESSION_GET_ACTIVE") return { ok: true, session: null };
      return { ok: true };
    });

    render(<SidePanelApp />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Finish 20 chemistry problems")).toBeInTheDocument()
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- SidePanelApp --run`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Write `SidePanelApp.tsx`**

```tsx
// src/sidepanel/SidePanelApp.tsx
import { useEffect, useState } from "react";
import { OnboardingWizard } from "../app/routes/OnboardingWizard";
import { SessionSetupForm } from "./components/SessionSetupForm";
import { SessionStatusCard } from "../shared/ui/SessionStatusCard";
import { TimerRing } from "../shared/ui/TimerRing";
import { useActiveSession } from "../popup/hooks/useActiveSession";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import { remainingSeconds } from "../domain/session/timer";
import type { UserSettings } from "../domain/settings/userSettings";

export function SidePanelApp() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const { session, loading } = useActiveSession();

  useEffect(() => {
    sendMessage<{ ok: boolean; settings: UserSettings }>({ type: "SETTINGS_GET" }).then((res) =>
      setSettings(res.settings)
    );
  }, []);

  if (loading || !settings) return <div className="sidepanel-app">Loading…</div>;

  if (!settings.onboardingCompleted) {
    return (
      <div className="sidepanel-app">
        <OnboardingWizard
          onComplete={() =>
            sendMessage<{ ok: boolean; settings: UserSettings }>({ type: "SETTINGS_GET" }).then((res) =>
              setSettings(res.settings)
            )
          }
        />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="sidepanel-app">
        <SessionSetupForm settings={settings} />
      </div>
    );
  }

  const totalSeconds =
    session.state === "BREAK" ? session.breakDurationSeconds : session.focusDurationSeconds;

  return (
    <div className="sidepanel-app">
      <SessionStatusCard session={session} />
      <TimerRing remainingSeconds={remainingSeconds(session, Date.now())} totalSeconds={totalSeconds} />
      <ul className="sidepanel-app__sites">
        {session.restrictedSites.map((site) => (
          <li key={site}>{site}</li>
        ))}
      </ul>
      <button onClick={() => sendMessage({ type: "SESSION_END", payload: { sessionId: session.id } })}>
        End session
      </button>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- SidePanelApp --run`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add src/sidepanel/
git commit -m "feat: add side panel with onboarding gate and session setup"
```

---

### Task 18: Options app

**Files:**
- Create: `src/options/OptionsApp.tsx`
- Test: `src/options/OptionsApp.test.tsx`

**Interfaces:**
- Consumes: `UserSettings` (Task 9), `sendMessage` (Task 11), `requestDetailedTrackingPermission`/`revokeDetailedTrackingPermission` (Task 12).
- Produces: `<OptionsApp />` — the options page entry point covering tracking tier, default restricted sites, and hard-block passcode setup.

- [ ] **Step 1: Write the failing test**

```tsx
// src/options/OptionsApp.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OptionsApp } from "./OptionsApp";
import * as messenger from "../infrastructure/messaging/extensionMessenger";
import * as permissionsApi from "../infrastructure/browser/permissionsApi";
import { DEFAULT_USER_SETTINGS } from "../domain/settings/userSettings";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OptionsApp", () => {
  it("requests detailed tracking permission when the user selects it", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, settings: DEFAULT_USER_SETTINGS });
    const requestSpy = vi
      .spyOn(permissionsApi, "requestDetailedTrackingPermission")
      .mockResolvedValue(true);

    render(<OptionsApp />);
    await waitFor(() => screen.getByLabelText("Detailed site tracking"));

    fireEvent.click(screen.getByLabelText("Detailed site tracking"));

    await waitFor(() => expect(requestSpy).toHaveBeenCalled());
  });

  it("saves a hard-block passcode", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, settings: DEFAULT_USER_SETTINGS });
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage");

    render(<OptionsApp />);
    await waitFor(() => screen.getByPlaceholderText(/passcode/i) || screen.getByLabelText(/passcode/i));

    fireEvent.change(screen.getByTestId("passcode-input"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save passcode" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "HARD_BLOCK_SET_PASSCODE",
        payload: { passcode: "1234" },
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- OptionsApp --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```tsx
// src/options/OptionsApp.tsx
import { useEffect, useState } from "react";
import type { UserSettings, TrackingTier } from "../domain/settings/userSettings";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import {
  requestDetailedTrackingPermission,
  revokeDetailedTrackingPermission,
} from "../infrastructure/browser/permissionsApi";

export function OptionsApp() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [passcode, setPasscode] = useState("");
  const [passcodeSaved, setPasscodeSaved] = useState(false);

  useEffect(() => {
    sendMessage<{ ok: boolean; settings: UserSettings }>({ type: "SETTINGS_GET" }).then((res) =>
      setSettings(res.settings)
    );
  }, []);

  if (!settings) return <div className="options-app">Loading…</div>;

  async function updateSettings(patch: Partial<UserSettings>) {
    const next = { ...settings!, ...patch };
    setSettings(next);
    await sendMessage({ type: "SETTINGS_SAVE", payload: next });
  }

  async function handleTrackingTierChange(tier: TrackingTier) {
    if (tier === "detailed") {
      const granted = await requestDetailedTrackingPermission();
      if (!granted) return;
    } else {
      await revokeDetailedTrackingPermission();
    }
    await updateSettings({ trackingTier: tier });
  }

  async function handleSavePasscode() {
    await sendMessage({ type: "HARD_BLOCK_SET_PASSCODE", payload: { passcode } });
    setPasscode("");
    setPasscodeSaved(true);
  }

  return (
    <div className="options-app">
      <section>
        <h2>Tracking</h2>
        <label>
          <input
            type="radio"
            checked={settings.trackingTier === "activity-only"}
            onChange={() => handleTrackingTierChange("activity-only")}
          />
          Activity-only
        </label>
        <label>
          <input
            type="radio"
            checked={settings.trackingTier === "detailed"}
            onChange={() => handleTrackingTierChange("detailed")}
          />
          Detailed site tracking
        </label>
      </section>

      <section>
        <h2>Default restricted sites</h2>
        <textarea
          value={settings.defaultRestrictedSites.join("\n")}
          onChange={(e) =>
            updateSettings({ defaultRestrictedSites: e.target.value.split("\n").filter(Boolean) })
          }
        />
      </section>

      <section>
        <h2>Hard-block passcode</h2>
        <p>Share this with a friend, not with yourself. Setting a new passcode replaces the old one.</p>
        <input
          data-testid="passcode-input"
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
        <button onClick={handleSavePasscode} disabled={passcode.length < 4}>
          Save passcode
        </button>
        {passcodeSaved && <p>Passcode saved.</p>}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- OptionsApp --run`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/options/
git commit -m "feat: add options page for tracking tier, site defaults, and hard-block passcode"
```

This completes Phase 4. A user can now onboard, set up a session, run it from the popup or side panel, and configure settings — entirely without the content-script overlay, which Phase 5 adds.

---

### Task 19: Content script entry and activity signals

**Files:**
- Create: `src/content/siteContext.ts`, `src/content/pageActivity.ts`, `src/content/index.ts`
- Test: `src/content/siteContext.test.ts`, `src/content/pageActivity.test.ts`

**Interfaces:**
- Consumes: `sendMessage` (Task 11).
- Produces: `currentHostname()`, `onUserActivity(callback)`. `content/index.ts` is the content-script entry point — per Decision #2 above, it only runs at all when detailed tracking is granted (WXT's `matches` for this entry point is configured to the empty/manual-registration pattern so it doesn't force a broad host permission at install time — see Step 4).

- [ ] **Step 1: Write the failing tests**

```ts
// src/content/siteContext.test.ts
import { describe, it, expect } from "vitest";
import { currentHostname } from "./siteContext";

describe("currentHostname", () => {
  it("returns window.location.hostname", () => {
    expect(currentHostname()).toBe(window.location.hostname);
  });
});
```

```ts
// src/content/pageActivity.test.ts
import { describe, it, expect, vi } from "vitest";
import { onUserActivity } from "./pageActivity";

describe("onUserActivity", () => {
  it("invokes the callback on mousemove", () => {
    const callback = vi.fn();
    onUserActivity(callback);

    window.dispatchEvent(new Event("mousemove"));

    expect(callback).toHaveBeenCalled();
  });

  it("returns a cleanup function that removes all listeners", () => {
    const callback = vi.fn();
    const cleanup = onUserActivity(callback);
    cleanup();

    window.dispatchEvent(new Event("keydown"));

    expect(callback).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- siteContext pageActivity --run`
Expected: FAIL — neither module exists yet.

- [ ] **Step 3: Write `siteContext.ts` and `pageActivity.ts`**

```ts
// src/content/siteContext.ts
export function currentHostname(): string {
  return window.location.hostname;
}
```

```ts
// src/content/pageActivity.ts
export function onUserActivity(callback: () => void): () => void {
  const events = ["mousemove", "keydown", "scroll"] as const;
  events.forEach((event) => window.addEventListener(event, callback, { passive: true }));
  return () => events.forEach((event) => window.removeEventListener(event, callback));
}
```

- [ ] **Step 4: Write `content/index.ts`**

```ts
// src/content/index.ts
import { mount } from "./overlay/overlayHost";
import { currentHostname } from "./siteContext";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import type { StudySession } from "../domain/session/sessionTypes";

export default defineContentScript({
  matches: [], // registered dynamically, see below — no static <all_urls> match here
  async main() {
    const activeResponse = await sendMessage<{ ok: boolean; session: StudySession | null }>({
      type: "SESSION_GET_ACTIVE",
    });

    if (!activeResponse.session || activeResponse.session.state !== "FOCUSING") return;

    const statusResponse = await sendMessage<{ ok: boolean; classification: string }>({
      type: "SITE_STATUS_REQUEST",
      payload: { hostname: currentHostname() },
    });

    mount({
      classification: statusResponse.classification as "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE",
      sessionId: activeResponse.session.id,
    });
  },
});
```

Per Decision #2, this content script is never injected via a static `matches: ["<all_urls>"]` entry — that would force the broad host-permission prompt on every install, defeating the whole point of the activity-only tier. Instead, `background/index.ts` (extended in Step 5 below) registers it dynamically with `chrome.scripting.registerContentScripts` only after detailed tracking permission is granted, and unregisters it if the user switches back to activity-only.

- [ ] **Step 5: Extend background wiring to register/unregister the content script**

```ts
// src/background/contentScriptRegistration.ts
const CONTENT_SCRIPT_ID = "snuffles-overlay";

export async function registerOverlayContentScript(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (existing.length > 0) return;

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      matches: ["*://*/*"],
      js: ["content-scripts/content.js"],
      runAt: "document_idle",
    },
  ]);
}

export async function unregisterOverlayContentScript(): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
}
```

Wire this into `OptionsApp.handleTrackingTierChange` (Task 18) and `OnboardingWizard.finish` (Task 16): call `registerOverlayContentScript()` right after `requestDetailedTrackingPermission()` succeeds, and `unregisterOverlayContentScript()` right after `revokeDetailedTrackingPermission()`. The exact bundled path (`content-scripts/content.js`) depends on WXT's build output naming for this entry point — confirm it against `.output/chrome-mv3/manifest.json` after running `npm run build` once Task 20 exists, and adjust the `js` array to match.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- siteContext pageActivity --run`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/content/siteContext.ts src/content/pageActivity.ts src/content/index.ts src/content/siteContext.test.ts src/content/pageActivity.test.ts src/background/contentScriptRegistration.ts
git commit -m "feat: add content script entry gated behind detailed tracking permission"
```

---

### Task 20: Animation registry and Snuffles overlay

**Files:**
- Create: `src/content/overlay/animationRegistry.ts`, `src/content/overlay/movementController.ts`, `src/content/overlay/SnufflesOverlay.tsx`, `src/content/overlay/overlayHost.ts`
- Test: `src/content/overlay/animationRegistry.test.ts`, `src/content/overlay/SnufflesOverlay.test.tsx`
- Create (placeholder assets): `public/sprites/placeholder-focused.png`, `placeholder-angry.png`, `placeholder-disappointed.png`, `placeholder-proud.png`, `placeholder-celebratory.png` — any small solid-color PNGs are fine for v1; hand-drawn frames replace these later without touching any code in this task (arch overview, Animation assets).

**Interfaces:**
- Consumes: `sendMessage` (Task 11), `currentHostname` (Task 19).
- Produces: `WellnessState`, `AnimationAsset`, `AnimationRegistry`, `getAnimationAsset(mode, wellnessState)`, `MovementPreference`, `initialPosition(preference)`, `<SnufflesOverlay />`, `mount(options)`.

- [ ] **Step 1: Write the failing test for the animation registry**

```ts
// src/content/overlay/animationRegistry.test.ts
import { describe, it, expect } from "vitest";
import { getAnimationAsset, ANIMATION_REGISTRY } from "./animationRegistry";

describe("animationRegistry", () => {
  it("returns the exact asset for a known mode/wellnessState pair", () => {
    const asset = getAnimationAsset("study", "angry");
    expect(asset.id).toBe("study-angry");
  });

  it("falls back to study/focused for an unregistered pair", () => {
    const asset = getAnimationAsset("play", "sleepy");
    expect(asset.id).toBe("study-focused");
  });

  it("gives every registered asset a non-empty staticFrame", () => {
    for (const asset of Object.values(ANIMATION_REGISTRY)) {
      expect(asset.staticFrame.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- animationRegistry --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write `animationRegistry.ts`**

```ts
// src/content/overlay/animationRegistry.ts
export type WellnessState =
  | "focused"
  | "angry"
  | "disappointed"
  | "sleepy"
  | "headache"
  | "proud"
  | "concerned"
  | "celebratory";

export interface AnimationAsset {
  id: string;
  mode: "study" | "break" | "play";
  wellnessState: WellnessState;
  frames: string[];
  frameDurationMs: number;
  staticFrame: string;
}

export type AnimationRegistry = Record<string, AnimationAsset>;

function key(mode: AnimationAsset["mode"], wellnessState: WellnessState): string {
  return `${mode}:${wellnessState}`;
}

// v1 ships placeholder art only: one static frame per entry. Hand-drawn
// frame sequences replace `frames` later without touching this shape.
export const ANIMATION_REGISTRY: AnimationRegistry = {
  [key("study", "focused")]: {
    id: "study-focused",
    mode: "study",
    wellnessState: "focused",
    frames: ["/sprites/placeholder-focused.png"],
    frameDurationMs: 0,
    staticFrame: "/sprites/placeholder-focused.png",
  },
  [key("study", "angry")]: {
    id: "study-angry",
    mode: "study",
    wellnessState: "angry",
    frames: ["/sprites/placeholder-angry.png"],
    frameDurationMs: 0,
    staticFrame: "/sprites/placeholder-angry.png",
  },
  [key("study", "disappointed")]: {
    id: "study-disappointed",
    mode: "study",
    wellnessState: "disappointed",
    frames: ["/sprites/placeholder-disappointed.png"],
    frameDurationMs: 0,
    staticFrame: "/sprites/placeholder-disappointed.png",
  },
  [key("study", "proud")]: {
    id: "study-proud",
    mode: "study",
    wellnessState: "proud",
    frames: ["/sprites/placeholder-proud.png"],
    frameDurationMs: 0,
    staticFrame: "/sprites/placeholder-proud.png",
  },
  [key("break", "celebratory")]: {
    id: "break-celebratory",
    mode: "break",
    wellnessState: "celebratory",
    frames: ["/sprites/placeholder-celebratory.png"],
    frameDurationMs: 0,
    staticFrame: "/sprites/placeholder-celebratory.png",
  },
};

export function getAnimationAsset(
  mode: AnimationAsset["mode"],
  wellnessState: WellnessState
): AnimationAsset {
  return ANIMATION_REGISTRY[key(mode, wellnessState)] ?? ANIMATION_REGISTRY[key("study", "focused")];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- animationRegistry --run`
Expected: PASS (3 tests)

- [ ] **Step 5: Write `movementController.ts`**

```ts
// src/content/overlay/movementController.ts
export type MovementPreference = "free" | "bottom-edge" | "bottom-only" | "static" | "hidden";

export function initialPosition(preference: MovementPreference): { x: number; y: number } {
  switch (preference) {
    case "free":
      return { x: 20, y: 20 };
    case "bottom-edge":
    case "bottom-only":
      return { x: 20, y: window.innerHeight - 120 };
    case "static":
      return { x: window.innerWidth - 140, y: window.innerHeight - 140 };
    case "hidden":
      return { x: -9999, y: -9999 };
  }
}
```

No dedicated test file — this is exercised via `SnufflesOverlay`'s positioning in the manual QA pass (Task 24), since it depends on `window.innerWidth`/`innerHeight`, which jsdom/happy-dom report as fixed defaults rather than anything meaningful to assert against.

- [ ] **Step 6: Write the failing test for `SnufflesOverlay`**

```tsx
// src/content/overlay/SnufflesOverlay.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SnufflesOverlay } from "./SnufflesOverlay";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SnufflesOverlay", () => {
  it("shows only the idle companion when the site is allowed", () => {
    render(
      <SnufflesOverlay
        classification="ALLOWED"
        sessionId="session_1"
        hostname="docs.google.com"
        reducedMotion={false}
      />
    );
    expect(screen.queryByText("That is not chemistry.")).not.toBeInTheDocument();
  });

  it("shows a warning with actions when the site is blocked", () => {
    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );
    expect(screen.getByText("That is not chemistry.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to work" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark this site as study-related" })).toBeInTheDocument();
  });

  it("sends MARK_SITE_STUDY_RELATED and dismisses the warning when clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    render(
      <SnufflesOverlay
        classification="BLOCKED"
        sessionId="session_1"
        hostname="youtube.com"
        reducedMotion={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark this site as study-related" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "MARK_SITE_STUDY_RELATED",
        payload: { sessionId: "session_1", hostname: "youtube.com" },
      })
    );
    expect(screen.queryByText("That is not chemistry.")).not.toBeInTheDocument();
  });

  it("uses the staticFrame image when reducedMotion is true", () => {
    render(
      <SnufflesOverlay classification="ALLOWED" sessionId="session_1" hostname="docs.google.com" reducedMotion />
    );
    expect(screen.getByAltText("Snuffles")).toHaveAttribute("src", "/sprites/placeholder-focused.png");
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- SnufflesOverlay --run`
Expected: FAIL — module does not exist.

- [ ] **Step 8: Write `SnufflesOverlay.tsx` and `overlayHost.ts`**

```tsx
// src/content/overlay/SnufflesOverlay.tsx
import { useState } from "react";
import { getAnimationAsset, type WellnessState } from "./animationRegistry";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

interface SnufflesOverlayProps {
  classification: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";
  sessionId: string;
  hostname: string;
  reducedMotion: boolean;
}

function wellnessStateFor(classification: SnufflesOverlayProps["classification"]): WellnessState {
  return classification === "BLOCKED" ? "disappointed" : "focused";
}

export function SnufflesOverlay({
  classification,
  sessionId,
  hostname,
  reducedMotion,
}: SnufflesOverlayProps) {
  const [dismissed, setDismissed] = useState(false);
  const asset = getAnimationAsset("study", wellnessStateFor(classification));
  const imageSrc = reducedMotion ? asset.staticFrame : asset.frames[0];

  if (classification !== "BLOCKED" || dismissed) {
    return (
      <div className="snuffles-overlay snuffles-overlay--idle">
        <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      </div>
    );
  }

  async function handleMarkStudyRelated() {
    await sendMessage({ type: "MARK_SITE_STUDY_RELATED", payload: { sessionId, hostname } });
    setDismissed(true);
  }

  return (
    <div className="snuffles-overlay snuffles-overlay--warning" role="alert">
      <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      <p>That is not chemistry.</p>
      <div className="snuffles-overlay__actions">
        <button onClick={() => setDismissed(true)}>Return to work</button>
        <button onClick={handleMarkStudyRelated}>Mark this site as study-related</button>
      </div>
    </div>
  );
}
```

```ts
// src/content/overlay/overlayHost.ts
import { createRoot } from "react-dom/client";
import { SnufflesOverlay } from "./SnufflesOverlay";
import { currentHostname } from "../siteContext";

interface MountOptions {
  classification: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";
  sessionId: string;
  reducedMotion?: boolean;
}

export function mount(options: MountOptions): void {
  const host = document.createElement("div");
  host.id = "snufflestudy-overlay-host";
  document.body.appendChild(host);

  const reducedMotion =
    options.reducedMotion ?? window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  createRoot(host).render(
    <SnufflesOverlay
      classification={options.classification}
      sessionId={options.sessionId}
      hostname={currentHostname()}
      reducedMotion={reducedMotion}
    />
  );
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -- SnufflesOverlay --run`
Expected: PASS (4 tests)

- [ ] **Step 10: Commit**

```bash
git add src/content/overlay/ public/sprites/
git commit -m "feat: add placeholder animation registry and Snuffles overlay"
```

---

### Task 21: Hard-block locked page

**Files:**
- Create: `src/app/routes/LockedPage.tsx`, `entrypoints/locked/index.html`, `entrypoints/locked/main.tsx`
- Test: `src/app/routes/LockedPage.test.tsx`

**Interfaces:**
- Consumes: `sendMessage` (Task 11), the `HARD_BLOCK_VERIFY_PASSCODE` message handled by `messageRouter.ts` (Task 13).
- Produces: `<LockedPage />`, rendered by the standalone `locked.html` extension page that `declarativeNetRequestApi.ts` (Task 12) redirects hard-restricted navigations to.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/routes/LockedPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LockedPage } from "./LockedPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/locked.html?site=youtube.com");
});

describe("LockedPage", () => {
  it("shows the restricted hostname from the query string", () => {
    render(<LockedPage />);
    expect(screen.getByText(/youtube.com is hard-restricted/)).toBeInTheDocument();
  });

  it("shows an error on an incorrect passcode", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: false });
    render(<LockedPage />);

    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("navigates to the site on a correct passcode", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    delete (window as any).location;
    (window as any).location = { href: "" };

    render(<LockedPage />);
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(window.location.href).toBe("https://youtube.com"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- LockedPage --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write `LockedPage.tsx`**

```tsx
// src/app/routes/LockedPage.tsx
import { useState, type FormEvent } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

export function LockedPage() {
  const params = new URLSearchParams(window.location.search);
  const site = params.get("site") ?? "this site";
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const response = await sendMessage<{ ok: boolean }>({
      type: "HARD_BLOCK_VERIFY_PASSCODE",
      payload: { passcode, hostname: site },
    });

    if (!response.ok) {
      setError("Incorrect passcode, or temporarily locked after repeated attempts.");
      return;
    }

    window.location.href = `https://${site}`;
  }

  return (
    <main className="locked-page">
      <h1>{site} is hard-restricted for this session</h1>
      <p>Ask whoever holds the passcode for it.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
        />
        <button type="submit">Unlock</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 4: Wire the standalone page entry point**

```html
<!-- entrypoints/locked/index.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Site restricted</title>
    <link rel="stylesheet" href="/styles/global.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

```tsx
// entrypoints/locked/main.tsx
import { createRoot } from "react-dom/client";
import { LockedPage } from "../../src/app/routes/LockedPage";

createRoot(document.getElementById("root")!).render(<LockedPage />);
```

WXT auto-discovers `entrypoints/locked/index.html` as an extension page named `locked.html` — this is what `declarativeNetRequestApi.ts` (Task 12) redirects to via `redirect: { extensionPath: "/locked.html?site=..." }`. Confirm the built filename matches by checking `.output/chrome-mv3/locked.html` exists after `npm run build`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- LockedPage --run`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/app/routes/LockedPage.tsx src/app/routes/LockedPage.test.tsx entrypoints/locked/
git commit -m "feat: add hard-block locked page with passcode entry"
```

This completes Phase 5. The extension now has a full in-page presence: soft-mode warnings via the content-script overlay, hard-mode enforcement via `declarativeNetRequest` + the locked page.

---

### Task 22: Design tokens and theming

**Files:**
- Create: `src/styles/tokens.css`, `src/styles/themes.css`, `src/styles/global.css`

**Interfaces:**
- Produces: CSS custom properties consumed by every component's class names from Tasks 14–21 (`.timer-ring`, `.session-status-card`, `.popup-app`, `.sidepanel-app`, `.onboarding-step`, `.session-setup-form`, `.options-app`, `.snuffles-overlay`, `.locked-page`). No task before this one references a token value directly, so wiring this in doesn't require touching any earlier file — only importing `global.css` at each entry point's HTML/root.

This task has no unit test — token values are visual, not logical, and the placeholder values here are explicitly a placeholder (arch overview, Design tokens and theming: a later Figma-driven pass swaps values here, not structure). Verification is manual, folded into Task 24's QA checklist.

- [ ] **Step 1: Write `tokens.css`**

```css
/* src/styles/tokens.css */
:root {
  --color-bg: #ffffff;
  --color-surface: #f5f5f7;
  --color-text: #1a1a1a;
  --color-text-muted: #6b6b6b;
  --color-primary: #6c4bd6;
  --color-warning: #d64b4b;
  --color-success: #2f9e5c;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 16px;

  --font-size-sm: 12px;
  --font-size-md: 14px;
  --font-size-lg: 20px;

  --motion-duration-fast: 120ms;
  --motion-duration-normal: 240ms;
}
```

- [ ] **Step 2: Write `themes.css`**

```css
/* src/styles/themes.css */
:root[data-theme="dark"] {
  --color-bg: #17171a;
  --color-surface: #232327;
  --color-text: #f2f2f2;
  --color-text-muted: #a3a3a3;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #17171a;
    --color-surface: #232327;
    --color-text: #f2f2f2;
    --color-text-muted: #a3a3a3;
  }
}
```

- [ ] **Step 3: Write `global.css`**

```css
/* src/styles/global.css */
@import "./tokens.css";
@import "./themes.css";

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: system-ui, sans-serif;
  font-size: var(--font-size-md);
}

.snuffles-overlay {
  position: fixed;
  z-index: 2147483647;
}

.snuffles-overlay--warning {
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
}
```

- [ ] **Step 4: Import `global.css` at every entry point**

Add `import "../styles/global.css";` (adjusting relative path per file) to the top of `popup/PopupApp.tsx`, `sidepanel/SidePanelApp.tsx`, `options/OptionsApp.tsx`, `content/overlay/overlayHost.ts`, and reference `/styles/global.css` from `entrypoints/locked/index.html` (already done in Task 21, Step 4).

- [ ] **Step 5: Verify manually**

Run: `npm run dev`, open the popup and side panel in Chrome, toggle OS/browser dark mode, and confirm background/text colors switch. This is folded into Task 24's full QA pass — no separate commit gate here beyond the one below.

- [ ] **Step 6: Commit**

```bash
git add src/styles/
git commit -m "feat: add design tokens and data-theme-based theming scaffold"
```

This completes Phase 6.

---

### Task 23: Playwright end-to-end smoke test

**Files:**
- Create: `tests/e2e/session-lifecycle.spec.ts`

**Interfaces:**
- Consumes: the built extension at `.output/chrome-mv3` (produced by `npm run build`, Task 1). No new production code — this is a black-box test of everything Tasks 1–22 built together.

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/session-lifecycle.spec.ts
import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";

let context: BrowserContext;

test.beforeAll(async () => {
  const pathToExtension = path.join(__dirname, "../../.output/chrome-mv3");
  context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
  });
});

test.afterAll(async () => {
  await context.close();
});

test("a session can be created from the side panel and shows a running timer", async () => {
  let [background] = context.serviceWorkers();
  if (!background) background = await context.waitForEvent("serviceworker");
  const extensionId = background.url().split("/")[2];

  // Pre-seed settings so the test exercises session setup, not onboarding —
  // onboarding's own flow is already covered by Task 16's component test.
  await background.evaluate(() => {
    return chrome.storage.local.set({
      "snufflestudy.settings": {
        pressureProfileId: "strict-coach",
        trackingTier: "activity-only",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: ["youtube.com"],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await page.getByPlaceholder("Finish 20 chemistry problems").fill("Read chapter 3");
  await page.getByRole("button", { name: "Start session" }).click();

  await expect(page.getByText("Read chapter 3")).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();

  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByPlaceholder("Finish 20 chemistry problems")).toBeVisible();
});
```

- [ ] **Step 2: Build the extension and run the test**

Run: `npm run build && npx playwright test`
Expected: PASS. If the service worker never fires, confirm `.output/chrome-mv3/manifest.json` has a `background.service_worker` entry (WXT should generate this automatically from `src/background/index.ts` / `entrypoints/background.ts` per Task 13, Step 6's note). If `sidepanel.html` 404s, confirm `wxt.config.ts`'s `side_panel.default_path` (Task 1) matches the file WXT actually emitted.

- [ ] **Step 3: Add a convenience script**

```json
// package.json — add to "scripts"
"test:e2e": "npm run build && playwright test"
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/session-lifecycle.spec.ts package.json
git commit -m "test: add e2e smoke test for the full session lifecycle"
```

---

### Task 24: Manual QA against the Definition of a quality first release

**Files:** none — this task produces no code, only a verification pass. Do it after Task 23 passes.

Run `npm run dev`, load the unpacked extension, and walk through the arch overview's "Definition of a quality first release" checklist (`docs/Draft1_Architecture_Overview.md`), trimmed to what v1 actually implements — item 14 ("invite friends later") is a design check, not a runtime one, since no friend UI exists yet.

- [ ] **Step 1:** Install the extension — load `.output/chrome-mv3-dev` unpacked in `chrome://extensions`, confirm no console errors on install.
- [ ] **Step 2:** Configure a pressure profile — open the side panel, complete onboarding, confirm the chosen profile persists (reopen the side panel, confirm `Settings → Tracking` reflects it via `OptionsApp`).
- [ ] **Step 3:** Create a concrete study goal — enter a goal in `SessionSetupForm`, confirm empty-goal submission shows the validation error from Task 8.
- [ ] **Step 4:** Define allowed and restricted sites — set at least one restricted site during onboarding (detailed tracking tier) or in Options; confirm it round-trips through `SETTINGS_GET`/`SETTINGS_SAVE`.
- [ ] **Step 5:** Start a session — click "Start session," confirm the popup and side panel both show `FOCUSING` with a live countdown within a second of each other.
- [ ] **Step 6:** Close and reopen the popup without losing state — close the popup mid-session, reopen it, confirm the timer shows the correct remaining time (not reset) — this is Task 4's `remainingSeconds` restoration guarantee, verified for real rather than simulated.
- [ ] **Step 7:** Visit an unapproved site and receive an intervention — with detailed tracking enabled and a soft-restricted site configured, navigate to that site in a new tab, confirm the Snuffles overlay appears with "That is not chemistry."
- [ ] **Step 8:** Return to the study task — click "Return to work" on the overlay, confirm it dismisses.
- [ ] **Step 9:** Pause or take an intentional break — click Pause in the popup, confirm the alarm is cancelled (`chrome://extensions` → service worker inspector → `chrome.alarms.getAll()` in the console returns none), then Resume and confirm the countdown continues from where it left off.
- [ ] **Step 10:** Complete or abandon the session — let a short test session (set focus duration to 1 minute via Options or the setup form) run to completion, confirm a `chrome.notifications` toast appears and the popup returns to the idle state.
- [ ] **Step 11:** Review what happened — open the service worker inspector, run `new (await import('/infrastructure/storage/indexedDbRepository.js')).IndexedDbSessionRepository().listHistory()` (adjust the import path to the built output) and confirm the completed session and its distraction event appear.
- [ ] **Step 12:** Use the extension offline — disconnect network (devtools → Network → Offline), start and complete a full session; confirm nothing breaks, since v1 has no backend to go offline from in the first place.
- [ ] **Step 13:** Disable or adjust pressure at any time — with no hard-block passcode configured, confirm "End session" always works. Configure a passcode in Options, set a session to hard restriction mode, confirm the locked page appears for that site and "End session" now requires the passcode (per Decision in Task 20/Site restriction modes — if this gate isn't implemented yet, that's a gap to fix before calling v1 done, not a deferred item).
- [ ] **Step 14 (design check, not runtime):** Confirm `StudySession.accountabilityGroupId` and `accountabilityUserIds` exist on the type (Task 2) even though nothing in v1 populates them — this is what "interfaces designed for future synchronization" means concretely.
- [ ] **Step 15:** Confirm reduced-motion is respected — enable "Reduce motion" in OS accessibility settings, trigger the overlay, confirm `SnufflesOverlay` renders `staticFrame` instead of animating (Task 20's `reducedMotion` prop, driven by `prefers-reduced-motion` in `overlayHost.ts`).
- [ ] **Step 16:** Confirm the permission model — check `chrome://extensions` → SnuffleStudy → Details → Site access, immediately after install (should show no site access, only `storage`/`alarms`/`notifications`/`idle`/`scripting`/`declarativeNetRequest`), then again after opting into detailed tracking during onboarding (should now show "On all sites," granted only at that point, not at install).

- [ ] **Step 17:** File any gap found above as a task before considering v1 done — do not silently ship a QA failure.

---

## Definition of done for v1

All of the following are true:

- `npm test -- --run` passes with zero failures across every file from Tasks 2–22.
- `npm run test:e2e` (Task 23) passes.
- The Task 24 manual QA pass has been run once against a freshly built extension with no unresolved gaps.
- No file under `src/domain/` imports anything from `chrome.*`, `src/infrastructure/`, or `src/content/` — verified by grep as a final check: `grep -rn "chrome\." src/domain/` should return nothing.
- The extension requests zero host permissions at install time — verified in Task 24, Step 16.

---

## Self-review

**Spec coverage.** Every "Core local product" and "Foundation" bullet from the arch overview's Development priorities maps to a task: session setup/goal entry/timer state machine/start-pause-resume-break-end-complete → Tasks 2–4, 13; timestamp-based restoration → Task 4 (explicit restart-simulation test); allowed/restricted site rules (soft mode) → Task 5; hard-block passcode → Tasks 6, 20, 21; local history → Task 10; basic pressure profiles → Task 7; initial Snuffles overlay → Tasks 19–20. Foundation's TypeScript/framework/manifest/popup/side-panel/service-worker/content-script/shared-types/storage/message-routing/testing/error-logging → Task 1 (scaffolding) plus Tasks 2, 9–13. The one Foundation item with no dedicated task is **error logging** — this plan relies on Vitest/Playwright failures surfacing build-time errors and `console.error` inside catch blocks is intentionally not added anywhere, since nothing in v1's message handlers currently swallows an exception silently (`handleMessage` lets thrown `Error`s from `sessionMachine.ts` propagate to the caller via the rejected message-response promise, which is visible in the caller's UI as a failed `sendMessage` call). If a dedicated logging surface is wanted, that's a scope addition, not a gap in what's written here.

**Placeholder scan.** No task contains "TBD," "handle appropriately," or an undefined referenced type — `SessionEvent`, `CreateSessionInput`, `HistoryQuery`, `UserSettings`, `HardBlockCredential`, `PressureProfile`, `AnimationAsset` are all fully defined before first use. The two spots that read like hedges (`fakeBrowser`'s `declarativeNetRequest` coverage in Task 12, the exact bundled content-script path in Task 19 Step 5) each carry a concrete fallback action, not an open question.

**Type consistency.** `StudySession.restrictionMode`/`siteRestrictionOverrides` (Task 2) match `restrictionModeFor` in Task 5, `syncHardBlockRules` in Task 12, and `SessionSetupForm`'s radio group in Task 17. `ExtensionMessage` (Task 11) covers every message type dispatched anywhere in Tasks 15–21 and handled in Task 13 — cross-checked: `SESSION_CREATE`, `SESSION_START`, `SESSION_PAUSE`, `SESSION_RESUME`, `SESSION_START_BREAK`, `SESSION_END_BREAK`, `SESSION_END`, `SESSION_GET_ACTIVE`, `SITE_STATUS_REQUEST`, `DISTRACTION_ATTEMPT`, `MARK_SITE_STUDY_RELATED`, `HARD_BLOCK_SET_PASSCODE`, `HARD_BLOCK_VERIFY_PASSCODE`, `SETTINGS_GET`, `SETTINGS_SAVE` — all 15 appear in both the union and the switch statement. `UserSettings` fields (`pressureProfileId`, `trackingTier`, `defaultFocusDurationSeconds`, `defaultBreakDurationSeconds`, `defaultAllowedSites`, `defaultRestrictedSites`, `defaultRestrictionMode`, `onboardingCompleted`) are used identically across `chromeStorageRepository.ts`, `OnboardingWizard.tsx`, `SessionSetupForm.tsx`, and `OptionsApp.tsx`.

---

**Plan complete and saved to `docs/V1_Implementation_Plan.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
