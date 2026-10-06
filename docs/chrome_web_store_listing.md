# Chrome Web Store listing — draft notes

Starting draft for the Developer Dashboard submission form. Review and edit before pasting in —
none of this is final copy, and the legal/regulatory bits especially need a human pass.

## Store listing

**Extension name:** SnuffleStudy

**Short description** (132 char max — for the search-results summary):

> A consensual peer-pressure study companion. Block distractions, and let friends hold you to it.

(132 chars incl. spaces — trim if the dashboard counts differently.)

**Detailed description** (the long-form listing body):

> SnuffleStudy turns studying into something your friends can actually hold you to — without
> anyone needing to keep a camera on.
>
> Set a focus session, pick a mascot "pressure style" from gentle encouragement to a theatrically
> ruthless roast, and SnuffleStudy watches for distraction (an unapproved tab, going idle) and
> nudges you back. Want it stricter? Hard-block a site for the whole session — the only way back
> in is a passcode, which you can require a friend to approve, so accountability is held by a
> person who agreed to it, not an algorithm.
>
> Add friends to share session activity (opt-in, and never your goal text or the specific sites
> you visit, unless you choose to let them see), send pre-recorded audio nudges instead of
> unmuting, or hop into a live Study Room together.
>
> SnuffleStudy works fully offline for the core timer and task list — the social layer is
> optional, not required.
>
> Privacy policy: https://chloewychan.github.io/SnuffleStudy/privacy-policy.html

**Category:** Productivity

**Language:** English

## Single purpose description

(Required field — one clear sentence stating what the extension does.)

> SnuffleStudy helps users stay focused during study sessions by blocking or restricting chosen
> distracting websites, and by letting the user's own friends provide accountability and
> approve access to a blocked site when asked.

## Permission justifications

Chrome Web Store review asks for a justification per sensitive permission. Draft text per
permission actually requested (`wxt.config.ts`):

- **storage** — stores the user's settings, active session state, and locally-hashed hard-block
  passcode on-device.
- **alarms** — schedules session timers, idle-state re-checks, and background sync polling that
  must survive MV3 service-worker suspension (can't rely on in-memory timers/`setTimeout`).
- **notifications** — shows a system notification when a friend sends a nudge, approves an
  unlock request, or a session completes.
- **idle** — detects when the user has gone idle during an active session, so the session can
  flag/pause appropriately instead of silently counting idle time as focused time.
- **scripting** — dynamically registers the content script that renders the on-page "locked"
  overlay and companion UI only on sites the user has chosen to restrict, rather than injecting
  into every page via a static manifest entry.
- **declarativeNetRequest** — enforces the user's own chosen hard-block list by redirecting
  blocked-site navigations to the extension's local "locked" page.
- **sidePanel** — hosts the main SnuffleStudy UI (timer, tasks, friends, settings) in Chrome's
  side panel.
- **host_permissions (optional, `*://*/*`)** — requested at runtime, not installed by default.
  Needed so the user can choose, during setup, which specific sites to hard-block or overlay —
  the extension cannot know in advance which sites a given user will pick, so the permission is
  scoped to exactly the hostnames the user adds, requested just-in-time via
  `chrome.permissions.request`.

## Data disclosure (Privacy practices tab)

Map to what the extension/backend actually does (cross-check against
`docs/privacy-policy.html`/`src/options/pages/PrivacyPolicyPage.tsx` before submitting):

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information | Yes | Email address, for account sign-in. |
| Health info | No | |
| Financial info | No | |
| Authentication info | Yes | Email + password / one-time code; passcodes are stored as hashes. |
| Personal communications | Yes | Audio nudge recordings; friend-request messages. |
| Location | No | |
| Web history | Yes (opt-in only) | Only the hostname of a site the user is actively blocked on, and only transmitted if the user enables "Share session activity." Never full browsing history. |
| User activity | Yes | Session start/pause/distraction/completion events; opt-in for sharing with friends. |
| Website content | No | |

**Certifications to check:**
- Confirm "This extension does not sell or transfer user data to third parties outside of
  approved use cases" — true as long as Anthropic/Resend/LiveKit usage stays scoped exactly as
  documented in the privacy policy (one-off, purpose-bound calls, no ad-tech sharing).
- Confirm compliance with the Developer Program Policies' Limited Use requirements.

## Support

- **Support URL / homepage:** https://github.com/chloewychan/SnuffleStudy
- **Support email:** (fill in — a monitored address, not necessarily a personal one)

## Pre-submission checklist

- [ ] Screenshots: 1280×800 or 640×400 (16:10), 1–5 images. Re-export from the existing Devpost
      gallery assets, which are the wrong ratio as-is.
- [ ] Small promo tile: 440×280 (optional but recommended).
- [ ] Icon: already correct (`public/icons/128.png`, used by the manifest).
- [ ] Privacy policy URL live and reachable (not just bundled in the extension).
- [ ] Version bumped off `0.0.0` (done — now `1.0.0`).
- [ ] Zip built via `npm run zip` from `snufflestudy/`, uploaded as the package.
