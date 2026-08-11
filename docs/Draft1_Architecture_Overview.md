# SnuffleStudy Architecture Overview

## Product vision

SnuffleStudy is a real, long-term browser extension for students who knowingly want aggressive accountability while studying.

It is not primarily a calm focus timer, a virtual pet, or a cosmetic reward game. Its defining feature is **consensual peer pressure**: users set a concrete study commitment, invite friends to hold them accountable, and give Snuffles permission to confront, interrupt, and expose distraction attempts when they try to abandon the commitment.

The core promise is:

> **Set a goal. Invite your friends. Try to escape. Snuffles and your accountability group will notice.**

Snuffles is a virtual bunny whose personality changes according to the user’s selected pressure style. The main style can be intense, judgmental, theatrical, and persistent. A gentle mode should still exist for users who prefer encouragement, but it should be an option rather than the product’s primary identity.

The product should be built as a quality, maintainable extension that people can actually use beyond the hackathon. The hackathon is an opportunity for exposure and validation, not the reason to use shortcuts, build a disposable mockup, or sacrifice the long-term architecture.

## Product principles

### Core identity

SnuffleStudy should feel like:

- A friend group enforcing a commitment.
- A chaotic study coach.
- A browser-level accountability system.
- A playful but strict intervention layer.
- A tool that helps users return to work after distraction.

It should not feel like:

- A generic Pomodoro timer.
- A passive productivity dashboard.
- A virtual pet whose cosmetics are the main motivation.
- A surveillance tool claiming to know whether a person is genuinely studying.
- An automated system that insults users without their permission.
- A social network that requires users to expose all of their browsing activity.


### Motivation model

The primary motivators are:

1. Concrete commitments.
2. Social visibility.
3. Configurable peer pressure.
4. Immediate interruption of distraction.
5. Friend intervention.
6. Recovery after failure.
7. Useful behavioral analytics.

Food, toys, clothing, rooms, and other virtual-pet rewards can remain, but they are secondary. They should add personality and provide a decompression experience rather than carry the entire motivation system.

The product should measure more than total study minutes. Important metrics include:

- Completed goals.
- Abandoned goals.
- Distraction attempts.
- Time before the first distraction.
- Number of successful recoveries.
- Friend interventions.
- Breaks taken intentionally.
- Recovery rate after distraction.

A valuable metric is:

> “You returned to focus 7 out of 9 times.”

This is more meaningful than an unrealistic perfect streak.

### Pressure boundaries

Aggression should mean:

- Theatrically judgmental.
- Socially visible.
- Persistent.
- Strict about user-defined rules.
- Funny and memorable.
- Configurable by the user and their friends.

It should not mean:

- Personal abuse.
- Threats.
- Humiliation outside the chosen accountability group.
- Unwanted notifications.
- Public exposure without consent.
- Language attacking someone’s identity, intelligence, or worth.

Users should explicitly choose the pressure level before beginning a session. Friends should interact through predefined pressure packs and approved messages rather than unrestricted insults by default.

## Main user experience

### Onboarding

The first-run flow should be short but meaningful:

1. Create or name Snuffles.
2. Choose a pressure style.
3. Choose a default study duration.
4. Choose whether to enable aggressive interruption.
5. Choose a tracking tier: activity-only or detailed site tracking. Detailed tracking requests site-visit permissions at this point rather than at install time; activity-only skips that request entirely. See [Tracking tiers](#tracking-tiers).
6. Configure basic allowed or restricted sites (only shown if detailed tracking is enabled).
7. Optionally create or join a friend group.
8. Start a first session.

Possible pressure styles:

- Ruthless.
- Roaster.
- Strict Coach.
- Parent Mode.
- Hype Squad.
- Gentle.
- Quiet or Low Distraction.

The user should be able to change styles later, but changing intensity during an active session may require confirmation.

### Session setup

Every session should begin with a concrete objective, not merely a duration.

Examples:

- Finish 20 chemistry problems.
- Write the introduction to my essay.
- Complete one LeetCode problem.
- Review 40 flashcards.
- Read chapters 3 and 4.
- Practice Spanish for 30 minutes.

Session configuration should include:

- Goal description.
- Focus duration.
- Break duration.
- Pressure style.
- Allowed websites.
- Restricted or suspicious websites.
- Accountability friends.
- Notification preferences.
- Whether distraction attempts are shared.
- Whether friend approval is required for unlocks.
- Whether the session allows emergency breaks.


### Study session

The primary session states are:

```text
IDLE
  ↓
SESSION_SETUP
  ↓
FOCUSING
  ├── PAUSED   (resume → FOCUSING)
  ├── BREAK    (resume → FOCUSING)
  ├── COMPLETED
  └── ABANDONED
```

`WARNING` and `NUDGED` are not lifecycle states. A user can be mid-warning while `PAUSED` or on a `BREAK`, so the lifecycle `state` above stays clean and distraction status is tracked separately by an orthogonal `interventionLevel: "none" | "warned" | "escalated"` that can change independently of `state`.

The user should always be able to see:

- Current state.
- Time remaining.
- Current goal.
- Pressure intensity.
- Whether the current website is allowed.
- Whether friends can see the session.
- Pause, break, and end controls.

The floating Snuffles interface should never be the only way to control the session. A popup, side panel, or keyboard-accessible control surface must remain available so users do not need to chase a moving character.

### Distraction intervention

This section describes the flow for `restrictionMode: "soft"` sites. A hard-restricted site does not go through a warning or escalation at all — the navigation is redirected straight to the passcode-locked page described in [Site restriction modes](#site-restriction-modes).

When the user visits a suspicious or soft-restricted site:

#### First warning

Snuffles displays a small but noticeable interruption:

> “That is not chemistry.”

Actions:

- Return to work.
- Take an intentional break.
- Ask for an unlock.
- Mark this site as study-related.
- End session.


#### Escalation

If the user remains on the site or repeatedly returns:

1. Snuffles becomes more animated.
2. A larger interruption appears.
3. A distraction attempt is recorded.
4. Accountability partners may receive a nudge.
5. Friends can send an approved message.
6. The user may need an unlock or explanation.

The system should not claim that the user is definitely procrastinating. Use language such as:

- “Unapproved site.”
- “Possible distraction.”
- “This site is outside your current rules.”
- “Is this part of your study session?”

This accommodates legitimate reading, research, communication, and unexpected study workflows.

### Recovery

If the user returns to the intended task, the product should acknowledge the recovery:

> “You escaped for three minutes and came back. Fine. Keep going.”

Recovery should be positively recorded, even in aggressive mode. SnuffleStudy should create pressure to return, not pressure that causes users to quit permanently.

If the user ends the session, the app should record:

- Goal.
- Time completed.
- Session state.
- Distraction attempts.
- Optional reason.
- Whether the user wants to reschedule.


## Feature architecture

### Focus and session management

Required capabilities:

- Create a session.
- Start a session.
- Pause a session.
- Resume a session.
- Start a planned break.
- End a session.
- Complete a session automatically.
- Abandon a session.
- Restore a session after browser restart.
- Support one active session initially.
- Design the data model so multiple devices and future session types are possible.

Session data should include:

```ts
type SessionState =
  | "IDLE"
  | "SESSION_SETUP"
  | "FOCUSING"
  | "PAUSED"
  | "BREAK"
  | "COMPLETED"
  | "ABANDONED";

type InterventionLevel = "none" | "warned" | "escalated";

interface StudySession {
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
  restrictionMode: "soft" | "hard";
  siteRestrictionOverrides?: Record<string, "soft" | "hard">;

  accountabilityGroupId?: string;
  accountabilityUserIds: string[];

  distractionAttempts: number;
  recoveries: number;
  friendNudges: number;
}
```


### Timer design

The timer must not depend on the popup remaining open.

Store timestamps such as:

```ts
{
  state: "FOCUSING",
  startedAt: 1786200000000,
  plannedEndAt: 1786201500000
}
```

Calculate the current remaining time from `plannedEndAt - Date.now()` whenever the popup, side panel, or content script needs to display it.

Use the service worker and Chrome alarms for scheduled events. Manifest V3 service workers are event-driven and can stop when inactive, so a timer should not rely on a permanently running background JavaScript loop.

When pausing:

- Calculate the remaining time.
- Save the remaining time.
- Set state to `PAUSED`.
- Cancel the active alarm.

When resuming:

- Create a new `plannedEndAt`.
- Set state to `FOCUSING`.
- Recreate the alarm.

`chrome.alarms` has roughly a one-minute firing granularity in packed extensions, so alarm-driven transitions (auto-complete, scheduled escalation) can lag the exact timestamp by up to a minute; the displayed countdown is unaffected since it is always computed live from `plannedEndAt`, not from the alarm firing.


### Allowed-site rules

The first version should let users manually define rules.

Example:

```ts
{
  allowedSites: [
    "docs.google.com",
    "canvas.instructure.com",
    "leetcode.com"
  ],
  restrictedSites: [
    "youtube.com",
    "reddit.com",
    "tiktok.com"
  ],
  restrictionMode: "soft"
}
```

`restrictedSites` replaces the earlier `blockedSites` naming. "Blocked" implied the site is unreachable; in practice a restricted site can be enforced two different ways, controlled by `restrictionMode`. See [Site restriction modes](#site-restriction-modes) below.

Classify the current page as:

```text
ALLOWED
BLOCKED
UNKNOWN
UNAVAILABLE
```

This classification applies to allowed, soft-restricted, unknown, and unavailable pages, all of which the content script actually loads on. Hard-restricted sites never reach this step — they're intercepted at the network layer by `declarativeNetRequest` before a content script runs, per [Site restriction modes](#site-restriction-modes).

Use hostname matching rather than raw string matching:

```ts
function isAllowedSite(
  hostname: string,
  allowedSites: string[]
): boolean {
  return allowedSites.some(
    site => hostname === site || hostname.endsWith(`.${site}`)
  );
}
```

Potential future rule types:

- Allowed domain.
- Restricted domain.
- Allowed URL path.
- Study category.
- Break-only site.
- Temporary approval.
- Friend-approved site.
- User-confirmed reading mode.

The user must be able to add a site during a session if it is genuinely necessary. A rigid system that blocks legitimate research will quickly lose trust. This applies to sites in `restrictionMode: "soft"`; sites in `"hard"` mode intentionally remove this self-serve escape hatch, see below.

### Site restriction modes

Each restricted site is enforced one of two ways:

- **Soft (default):** the existing content-script warning/escalation flow. The user can still reach the site; Snuffles nudges, escalates, and records the attempt.
- **Hard:** the site is not reachable at all without a passcode. No in-session "ask for unlock" — the only way through is Settings, which requires the passcode.

`restrictionMode` can be set per session and overridden per site via an optional `siteRestrictionOverrides: Record<string, "soft" | "hard">`, so a user can hard-block one specific problem site while leaving the rest soft.

**Enforcement mechanism.** Soft mode stays as the content-script overlay already described. Hard mode should not rely on a content-script overlay alone — a user who opens devtools can simply delete that DOM node. Use `declarativeNetRequest` dynamic rules to redirect navigation on hard-restricted hostnames to an extension-hosted page (e.g. `chrome-extension://.../locked.html`) that hosts the passcode prompt. This means hard mode needs its dynamic rule set kept in sync with session state (rules added when a session with hard-restricted sites starts, removed when it ends).

**The passcode.** Modeled on how students already share Screen Time codes: the user sets a passcode once in Settings and shares it with a friend out of band (text, Discord, in person). This needs no backend and no friend account, so it can ship in the Core local product phase rather than waiting on the Accountability phase.

```ts
interface HardBlockCredential {
  passcodeHash: string;
  passcodeSalt: string;
  failedAttempts: number;
  lockedUntil?: number;
}
```

- Store only a salted hash (`crypto.subtle.digest`), never the plaintext passcode, so it isn't visible to casual inspection of extension storage.
- Rate-limit guesses with backoff (`failedAttempts` / `lockedUntil`) to blunt brute-forcing a short PIN.
- A correct entry unlocks the specific site for the remainder of the current session by default; extending or removing restrictions entirely requires re-entering the passcode.
- Be explicit with users that this is friction, not a security boundary: like Screen Time, it can still be defeated by disabling or uninstalling the extension at the browser level. The value is the social commitment of handing the code to someone else, not cryptographic enforcement.

This also interacts with the kill switch required under [Privacy and safety requirements](#privacy-and-safety-requirements): when a hard-block passcode is configured, both visiting a hard-restricted site and disabling pressure require it. Sessions with no passcode configured keep the fully unrestricted kill switch.

### Pressure profiles

Pressure profiles should be data-driven rather than hardcoded across the application.

```ts
interface PressureProfile {
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
```

Example profiles:

- Gentle Encouragement.
- Strict Coach.
- Ruthless Roaster.
- Parent Mode.
- Hype Squad.
- Silent Enforcement.

This makes the extension expandable without rewriting the session system whenever new personalities are added.

### Friend accountability

The initial social model should be small and functional:

- Create a group.
- Join through an invite code.
- Invite specific friends.
- Start a session visible to the group.
- Send predefined nudges.
- Approve or deny unlock requests.
- See completed, active, and abandoned sessions.

Friends should receive event-based updates rather than constant activity streams:

- Session started.
- Distraction attempt.
- Break requested.
- Unlock requested.
- User returned.
- Goal completed.
- Session abandoned.

Privacy controls should let the session owner choose whether friends can see:

- Only active/completed status.
- Goal text.
- Time remaining.
- Distraction attempts.
- Current domain.
- Number of interventions.
- Full session history.

The default should be minimal visibility.

### Per-friend nudge settings

Visibility above controls what a friend can see. Nudging is a separate axis — whether a friend can interrupt the user, and whether the user can interrupt that friend — and needs its own per-friendship settings, distinct from the per-session pressure profile:

```ts
interface FriendshipSettings {
  friendUserId: string;
  receiveLiveNudgesFromFriend: boolean; // this friend may nudge me
  sendLiveNudgesToFriend: boolean;      // I may nudge this friend
  receiveDailyDigestForFriend: boolean; // daily summary instead of/alongside live nudges
  nudgeCooldownSeconds: number;
}
```

- `nudgeCooldownSeconds` is a per-friend-pair rate limit, independent of `PressureProfile.maxNudgesPerSession`. One overly enthusiastic friend should not be able to spam nudges regardless of the active profile's session-wide cap.
- Being in someone's accountability group does not imply live nudges are on. A user can keep a friend for visibility and the daily digest without ever sending or receiving a live interruption from them.
- **Daily digest.** A friend pair can opt into a once-a-day summary instead of, or alongside, live nudges — "Bob was really locked in today. See his study summary." This reuses the session-completion events already synced to the backend for accountability visibility, so it needs no new client-side tracking, only scheduled aggregation and a digest view. It belongs in the Accountability/backend phase: a digest about a friend's stats can't be assembled from local-only data on the viewer's device.

### Notifications

Notification channels should eventually include:

- In-extension message.
- Browser notification.
- Friend-group event.
- Daily digest.
- Optional email.
- Optional SMS.

SMS and email should not be foundational features. They require additional services, privacy controls, rate limits, quiet hours, and cost management. Build the internal event system first so external notification channels can later subscribe to the same events.

### Friend-event delivery

How a friend's nudge, distraction event, or unlock request actually reaches another user's browser is a separate decision from what the event contains. Sequence it the same way SMS and email are sequenced above: build the simple, self-contained version first, add the more capable channel later as an additional subscriber to the same event system, not a replacement for it.

**Phase 1 — polling (Accountability product phase).** The service worker polls Supabase directly on a `chrome.alarms` cadence (roughly once a minute) for new friend-group events, and shows a `chrome.notifications` toast for anything new. No Firebase involved at this stage.

- Only run the alarm while there is an active session with friend features enabled; skip it entirely when idle, to keep backend load and battery use proportional to actual usage.
- This adds up to roughly two alarm intervals of round-trip latency in the worst case — one interval for the friend's client to notice the distraction event, another for the user's client to notice the friend's nudge back — which is acceptable given nudges are already gated behind an escalation threshold, not fired the instant a tab opens.

**Phase 2 — push upgrade (Long-term product phase, conditional).** Once live nudges are validated as a feature people actually rely on — or the polling latency becomes a repeated real complaint rather than a theoretical one — add Firebase Cloud Messaging purely as a delivery pipe: a Supabase trigger or edge function calls FCM on new friend events, FCM wakes the service worker's `push` event, and the handler does the same "fetch and show a notification" work the poll handler already does. This does not replace Supabase as the source of truth for event data, and does not pull the rest of Firebase (Firestore, Firebase Auth) into the stack.
- Treat this as a spike before committing to it: push-event support in an MV3 extension service worker is less battle-tested than in a regular web-page service worker.
- Because delivery lives entirely in the infrastructure layer, this upgrade only touches the infrastructure adapter that turns "a new event exists" into "show a notification" — the domain layer, event types, and UI do not change.

### Virtual companion

Snuffles should have three main modes:

#### Study Mode

- Focused animation.
- Subtle check-ins.
- Pressure messages.
- Distraction reactions.
- Session status.
- Minimal visual interference.


#### Break Mode

- Relaxed animation.
- Health reminders.
- Optional Play Mode access.
- Countdown to returning.
- No unnecessary guilt.


#### Play Mode

- Wandering.
- Dancing.
- Mini-games.
- Food and toys.
- Room interaction.
- Cosmetic customization.

The product should support movement preferences:

- Walk freely.
- Stay near the bottom edge.
- Move only along the bottom.
- Static placement.
- Low-distraction mode.
- Reduced-motion mode.
- Hide temporarily.

The content-script overlay exists per webpage. It should not be treated as one global desktop overlay. Each eligible tab may receive its own Snuffles renderer, while centralized session state remains in the service worker and storage. Content scripts also cannot run on every privileged browser page or internal Chrome page, so the extension should show a graceful unsupported-page state.

### Wellness states

Keep emotional states because they make Snuffles memorable, but use them as prompts rather than medical judgments.

Possible states:

- **Focused:** user is actively in a session.
- **Angry:** repeated unapproved-site attempts in ruthless mode.
- **Disappointed:** user ignored a warning.
- **Sleepy:** scheduled break or late-night session.
- **Headache:** long session without a break, phrased as a visual-fatigue reminder.
- **Proud:** goal completed.
- **Concerned:** user has been inactive for an extended period.
- **Celebratory:** successful recovery or completion.

The application should not claim to medically detect headaches, fatigue, or emotional conditions. These are expressive companion states.

### Animation assets

Snuffles ships with placeholder animation first (simple shapes, a static image, or minimal CSS) and hand-drawn frame-by-frame animation later, once the extension itself is basically finished. Wellness-state and mode logic should never reference specific art directly — it should look up a symbolic key in an asset registry, so replacing placeholder art with hand-drawn frames later is a registry change, not a rewrite of session or overlay logic.

```ts
type WellnessState =
  | "focused"
  | "angry"
  | "disappointed"
  | "sleepy"
  | "headache"
  | "proud"
  | "concerned"
  | "celebratory";

interface AnimationAsset {
  id: string;
  mode: "study" | "break" | "play";
  wellnessState: WellnessState;
  frames: string[];       // ordered frame image paths, e.g. public/sprites/...
  frameDurationMs: number;
  staticFrame: string;    // required fallback for reduced-motion mode
}

type AnimationRegistry = Record<string, AnimationAsset>;
// keyed by `${mode}:${wellnessState}`
```

- **Frame-by-frame is the chosen technique.** Hand-drawn frame sequences, delivered as sprite sheets or ordered image sequences in `public/sprites/`, played back with a lightweight CSS `steps()` animation or a small frame-swapping player. This matches a traditional flipbook drawing pipeline directly and avoids taking on a vector animation runtime (Rive, Lottie) the art was never authored for.
- **`staticFrame` is required on every asset, not optional.** Reduced-motion mode swaps `frames` playback for `staticFrame` display. Making it a required field means every future addition to the registry satisfies the existing reduced-motion requirement automatically, rather than depending on someone remembering it per state.
- **Load asset bundles per mode, not all at once.** Play Mode's frame sequences (mini-games, food, toys) should not be part of the bundle a Study Mode session loads. Lazy-load each mode's `AnimationAsset` entries when that mode is entered, so extension size and content-script injection time don't grow every time more hand-drawn art is added.
- Placeholder art is simply a sparse registry — one `staticFrame`, a one-frame `frames` array, `frameDurationMs` unused — so the overlay component never needs a separate code path for "placeholder" versus "final" art.

## Technical architecture

### Recommended stack

Use a real application structure from the beginning:

- **TypeScript:** safer state models, message types, and API boundaries.
- **React:** popup, side panel, settings, dashboard, and reusable interface components.
- **Vite:** frontend build tooling.
- **WXT or a similar browser-extension framework:** extension entry points, development workflow, and browser targets.
- **CSS Modules, Tailwind, or a small design system:** consistent UI styling.
- **Chrome Manifest V3:** browser extension platform.
- **Chrome Storage API:** settings and active session state.
- **IndexedDB, preferably through a repository abstraction:** larger session history and event records.
- **Supabase (Postgres):** accounts, groups, friend events, and synchronization, added later. See [Backend and social expansion](#backend-and-social-expansion).
- **Firebase Cloud Messaging:** push-delivery upgrade for friend nudges only, added after polling proves it's needed. See [Friend-event delivery](#friend-event-delivery).
- **GitHub:** source control and issue tracking.
- **Vitest or Jest:** unit tests.
- **Playwright:** extension-level and browser workflow testing.

The important decision is not the specific framework. The important decision is that the application is divided into reusable domain logic and browser-specific adapters.

### Design tokens and theming

The specific styling approach — CSS Modules, Tailwind, or a small design system — can stay a later decision, but where design values live should not. Use `styles/tokens.css` as the single canonical source of design tokens: CSS custom properties for color, spacing, radii, type scale, and motion durations. Whichever styling approach gets chosen should read from these variables rather than duplicating values — a Tailwind theme config, for example, should point at the same custom properties rather than redefining its own palette.

This matters specifically because the UI will be designed in Figma later, for the side panel and other surfaces that need to be dynamic and polished: Figma variables (color styles, spacing, type scale) then have exactly one place to land in code, so a design pass updates `tokens.css` rather than requiring a hunt through components for hardcoded values.

Theming should use CSS custom properties switched by a `data-theme` attribute on the root element, defaulting to `prefers-color-scheme`, from the first implementation — even while only one theme exists. That way a later light/dark redesign is "add a second set of variable values" in `themes.css`, not "introduce a theming mechanism that doesn't exist yet."

### Suggested repository structure

```text
snufflestudy/
├── src/
│   ├── app/
│   │   ├── routes/
│   │   ├── providers/
│   │   └── appConfig.ts
│   │
│   ├── background/
│   │   ├── index.ts
│   │   ├── alarmHandlers.ts
│   │   ├── tabHandlers.ts
│   │   ├── notificationHandlers.ts
│   │   └── messageRouter.ts
│   │
│   ├── popup/
│   │   ├── PopupApp.tsx
│   │   ├── pages/
│   │   └── components/
│   │
│   ├── sidepanel/
│   │   ├── SidePanelApp.tsx
│   │   └── components/
│   │
│   ├── content/
│   │   ├── index.ts
│   │   ├── overlay/
│   │   │   ├── SnufflesOverlay.tsx
│   │   │   ├── overlayHost.ts
│   │   │   ├── movementController.ts
│   │   │   └── animationRegistry.ts
│   │   ├── pageActivity.ts
│   │   └── siteContext.ts
│   │
│   ├── options/
│   │   ├── OptionsApp.tsx
│   │   └── pages/
│   │
│   ├── domain/
│   │   ├── session/
│   │   │   ├── sessionTypes.ts
│   │   │   ├── sessionMachine.ts
│   │   │   ├── sessionSelectors.ts
│   │   │   └── sessionValidation.ts
│   │   ├── sites/
│   │   │   ├── siteRules.ts
│   │   │   ├── hostnameMatching.ts
│   │   │   └── hardBlockCredential.ts
│   │   ├── pressure/
│   │   │   ├── pressureProfiles.ts
│   │   │   └── pressureEngine.ts
│   │   ├── accountability/
│   │   │   └── friendshipSettings.ts
│   │   └── analytics/
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
│   │   ├── messaging/
│   │   │   └── extensionMessenger.ts
│   │   └── backend/
│   │       └── apiClient.ts
│   │
│   ├── shared/
│   │   ├── messages.ts
│   │   ├── constants.ts
│   │   ├── errors.ts
│   │   └── utils/
│   │
│   └── styles/
│       ├── tokens.css
│       ├── global.css
│       └── themes.css
│
├── public/
│   ├── icons/
│   ├── sprites/
│   └── sounds/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── manifest.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

This is intentionally more structured than a one-week prototype. It allows Claude or another developer to implement the initial session engine without later having to move all logic out of popup files and a single background script.

## Application layers

### Presentation layer

Contains:

- Popup.
- Side panel.
- Options/settings page.
- Dashboard.
- Content-script Snuffles overlay.
- Notifications and interruption cards.

Presentation code should display state and dispatch actions. It should not contain the core timer rules or directly manipulate storage everywhere.

Keep components small and named after the actual UI concept (`TimerRing`, `PressureProfilePicker`, `SessionStatusCard`) rather than a few large screen components. The first-pass implementation will use placeholder styling, but a later Figma-driven design pass should be able to restyle one component at a time — that only works if each component already maps to one meaningful unit of UI, not an entire screen that needs decomposing first.

### Domain layer

Contains browser-independent logic:

- Session state transitions.
- Goal validation.
- Timer calculations.
- Site-rule matching.
- Pressure escalation.
- Event definitions.
- Analytics calculations.
- Privacy policy decisions.

This layer should be testable in Node without launching Chrome.

### Infrastructure layer

Contains:

- Chrome APIs.
- Storage implementation.
- Alarm implementation.
- Tab querying.
- Browser notifications.
- Backend API.
- Realtime friend communication.

The domain layer should not need to know whether data is stored in Chrome storage, IndexedDB, or a remote backend.

### Coordination layer

The service worker coordinates:

- Session alarms.
- Active-tab changes.
- Cross-context messages.
- Storage updates.
- Notifications.
- Future friend events.

The service worker should be treated as an event coordinator, not a permanent application server.

## Messaging model

Define typed messages in one shared file:

```ts
type ExtensionMessage =
  | {
      type: "SESSION_CREATE";
      payload: CreateSessionInput;
    }
  | {
      type: "SESSION_PAUSE";
      payload: { sessionId: string };
    }
  | {
      type: "SESSION_RESUME";
      payload: { sessionId: string };
    }
  | {
      type: "SESSION_START_BREAK";
      payload: { sessionId: string };
    }
  | {
      type: "SESSION_END";
      payload: { sessionId: string; reason?: string };
    }
  | {
      type: "SESSION_GET_ACTIVE";
    }
  | {
      type: "SITE_STATUS_REQUEST";
      payload: { url: string };
    }
  | {
      type: "DISTRACTION_ATTEMPT";
      payload: {
        sessionId: string;
        hostname: string;
      };
    }
  | {
      type: "FRIEND_NUDGE";
      payload: {
        sessionId: string;
        messageId: string;
      };
    };
```

This prevents every part of the application from inventing different message formats.

## Storage strategy

Use a storage abstraction from the start.

### Chrome storage

Use `chrome.storage.local` for:

- Current active session.
- User settings.
- Pressure preferences.
- Site rules.
- Hard-block passcode credential (hashed; see [Site restriction modes](#site-restriction-modes)).
- Per-friend nudge settings (cached locally for offline enforcement; synced from the backend once it exists).
- Current account identifier.
- Small caches.
- Feature flags.


### IndexedDB

Use IndexedDB for:

- Long-term session history.
- Session event logs.
- Distraction records.
- Analytics data.
- Cached friend-group events.
- Offline records waiting to sync.

A repository interface could look like:

```ts
interface SessionRepository {
  getActive(): Promise<StudySession | null>;
  saveActive(session: StudySession): Promise<void>;
  archive(session: StudySession): Promise<void>;
  listHistory(options?: HistoryQuery): Promise<StudySession[]>;
  recordEvent(event: SessionEvent): Promise<void>;
}
```

This means the UI and domain logic do not care where the records are stored.

### Offline-first behavior

The extension should still work without an internet connection:

- Sessions run locally.
- Timers continue based on timestamps.
- Site rules remain available.
- Local analytics remain available.
- Friend events are queued or marked unavailable.
- Sync resumes when connectivity returns.

A user should never lose the ability to study simply because the backend is offline.

## Backend and social expansion

The backend should be added when the local session engine is stable.

Potential services:

- Authentication.
- User profiles.
- Friend groups.
- Invite codes.
- Accountability permissions.
- Session status synchronization.
- Friend nudge events.
- Per-friend nudge settings and rate limits (send/receive toggles enforced server-side, ideally via row-level security, so a blocked sender's nudge never reaches the recipient's client).
- Push-notification registration (Phase 2 upgrade only, see [Friend-event delivery](#friend-event-delivery); friend nudges deliver by polling before this exists).
- Moderation and abuse reporting.
- Optional social history.

Do not send complete browsing history to the backend. A friend should receive only the event information the user has authorized, such as:

```ts
{
  type: "DISTRACTION_ATTEMPT",
  sessionId: "session_123",
  displayLabel: "Unapproved site",
  occurredAt: 1786201200000
}
```

Do not transmit the exact URL unless the user explicitly enables that visibility.

## Privacy and safety requirements

Because this extension observes browser context and enables social pressure, privacy must be part of the architecture rather than an afterthought.

Required controls:

- Clear permission explanation.
- Per-feature permission requests.
- Private mode.
- Friend-only sharing.
- Hide current domain.
- Hide distraction attempts.
- Quiet hours.
- Maximum notifications per session.
- Emergency pause.
- Disable all pressure.
- Remove friend access.
- Delete local history.
- Export user data.
- Delete account and remote data.
- Reduced-motion mode.
- Accessible interruption controls.

The user must be able to override the system. Aggressive accountability should be powerful because the user chose it, not because the extension makes itself impossible to escape.

### Tracking tiers

Detailed site classification (allowed/restricted/unknown) requires knowing which hostname the user is on, which in Chrome means host permissions broad enough to draw real scrutiny in review, and real discomfort for a user who just wants focus tracking. Offer two tiers at onboarding instead of requesting the broad grant upfront:

- **Activity-only.** Tracks whether the user is actively engaged — `chrome.idle` state plus generic keyboard/mouse/scroll signals from a content script that never reads the URL. Requests no host permissions at all.
- **Detailed site tracking.** Adds hostname classification, the allowed/restricted site rules, and distraction detection described above. Request the underlying host permissions as `optional_host_permissions` via `chrome.permissions.request` at the moment the user opts in — during onboarding or later in Settings — never as a required install-time permission.

A user can switch tiers later; switching to activity-only should also revoke the granted host permissions with `chrome.permissions.remove`.

Treat any age gate on detailed tracking as informed consent, not verification. Chrome gives extensions no way to confirm a user's actual age, so an "18+" prompt sets expectations and reduces the default footprint — it does not enforce anything, and the architecture should not assume otherwise.

## Development priorities

The extension should be built in layers, but the initial structure should represent the full product.

### Foundation

- TypeScript project.
- Extension framework.
- Manifest V3.
- Popup.
- Side panel or future side-panel entry point.
- Service worker.
- Content-script entry point.
- Shared types.
- Storage repositories.
- Message routing.
- Testing setup.
- Error logging.


### Core local product

- Session setup.
- Goal entry.
- Timer state machine.
- Start, pause, resume, break, end, and complete.
- Timestamp-based timer restoration.
- Allowed and restricted site rules (soft mode).
- Hard-block passcode for restricted sites (no backend required).
- Local history.
- Basic pressure profiles.
- Initial Snuffles overlay.


### Accountability product

- Friend groups.
- Invite codes.
- Live session status.
- Predefined nudges, delivered by polling Supabase on a `chrome.alarms` cadence (see [Friend-event delivery](#friend-event-delivery)).
- Per-friend nudge settings and rate limits.
- Daily accountability digest.
- Unlock requests.
- Pressure escalation.
- Privacy controls.
- Notification preferences.


### Long-term product

- Analytics dashboard.
- IndexedDB history.
- Offline sync.
- Multiple devices (including passive companion use, e.g. an iPad open beside a laptop with no mouse or keyboard input — idle detection should not misread that as distraction).
- FCM push notifications for friend nudges (upgrade from polling once usage justifies it; see [Friend-event delivery](#friend-event-delivery)).
- Email or SMS as optional integrations.
- Bunny Land study groups.
- Co-working rooms.
- Additional Snuffles personalities.
- Play Mode expansion.
- Cross-browser support.


## Definition of a quality first release

A meaningful first release should let a user:

1. Install the extension.
2. Configure a pressure profile.
3. Create a concrete study goal.
4. Define allowed and restricted sites.
5. Start a session.
6. Close and reopen the popup without losing state.
7. Visit an unapproved site and receive an intervention.
8. Return to the study task.
9. Pause or take an intentional break.
10. Complete or abandon the session.
11. Review what happened.
12. Use the extension offline.
13. Disable or adjust pressure at any time.
14. Invite friends later without requiring a complete social platform immediately.

The first implementation can be local-only, but its interfaces should be designed for future synchronization.

## Guidance for Claude or another LLM

Use the following as the implementation context:

> Build SnuffleStudy as a production-oriented Chrome Manifest V3 browser extension, not a disposable hackathon mockup. The product is a peer-pressure study accountability system centered around a virtual bunny named Snuffles. Its primary identity is aggressive, theatrical, consensual accountability: users create concrete study goals, define allowed and restricted sites, invite friends, and authorize Snuffles and those friends to confront them when they attempt to procrastinate. Gentle mode exists as an alternative, but calm encouragement is not the main product.
>
> Use a scalable architecture with TypeScript, React, a modern extension build framework such as WXT, a service worker, popup, future side panel, content-script overlay, shared typed messages, domain-layer session state logic, browser API adapters, storage repositories, and testable infrastructure. Use Chrome storage for active settings and current state, IndexedDB for scalable session history and event logs, and a future backend abstraction for accounts, groups, friend events, and sync.
>
> The main domain object is a study session with a concrete goal, focus duration, break duration, pressure profile, allowed sites, restricted sites, accountability group, timestamps, state, distraction attempts, recoveries, and completion status. Use an explicit state machine: IDLE, SESSION_SETUP, FOCUSING, PAUSED, BREAK, COMPLETED, and ABANDONED. Track distraction/nudge status separately with an orthogonal interventionLevel (none, warned, escalated) that can change independently of the lifecycle state. Timers must be timestamp-based and survive popup closure, browser restarts, and service-worker suspension. Use Chrome alarms for scheduled transitions.
>
> Build the local session engine before complex social features, but keep the entire architecture expandable. The user experience should include escalation when an unapproved site is opened, configurable pressure profiles, friend nudges with per-friend send/receive settings and rate limits, a daily accountability digest, unlock requests, intentional breaks, recovery recognition, privacy controls, quiet hours, reduced-motion support, and a kill switch. Restricted sites have a soft mode (nudge and escalate, user can still proceed) and a hard mode (no self-serve unlock; requires a passcode the user shares with a friend out of band, similar to a Screen Time code) — hard mode needs no backend and should ship early. Offer two tracking tiers at onboarding: activity-only, which needs no host permissions, and detailed site tracking, whose host permissions should be requested at runtime via optional_host_permissions only when the user opts in. Deliver friend nudges by polling Supabase on a chrome.alarms cadence first; only add Firebase Cloud Messaging as a push-delivery upgrade later, once polling latency actually proves to be a problem. Never claim to know whether the user is truly studying; distinguish allowed, restricted, unknown, and unavailable sites.
>
> Snuffles should have Study Mode, Break Mode, and Play Mode. Study Mode emphasizes focus and pressure. Break Mode supports intentional rest. Play Mode includes optional mini-games, food, toys, and customization, but cosmetics are secondary and should not be the main retention mechanic. Analytics should focus on goals, distraction attempts, recovery rate, interventions, and completed work rather than only total minutes.
>
> Do not begin with a flat folder containing all logic in popup.js or background.js. Establish domain types, repositories, message contracts, state transitions, browser adapters, and tests from the beginning. Build the first version locally and offline-first, then add backend synchronization and friend accountability through replaceable interfaces.

This architecture lets you move quickly without building a dead-end prototype. The first milestone can remain modest, but every major future feature—aggressive interventions, friend pressure, analytics, social groups, Play Mode, and backend sync—will have a clear place to live.