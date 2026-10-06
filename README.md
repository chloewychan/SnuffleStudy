# SnuffleStudy

A consensual peer-pressure study accountability companion — a Chrome extension that pairs a
focus-session timer with real friends who can see when you drift and nudge you back, without
anyone needing to keep a camera on.

Group study calls work because someone can see you're off-task. Once cameras go off, that
accountability disappears — SnuffleStudy puts it back by having the extension watch for
distraction (unapproved tabs, inactivity) and surfacing it to the friends you've chosen to loop
in, so the social pressure that makes group study work doesn't depend on anyone staying on video.

## Features

- **Focus sessions** — set a goal and a duration from the side panel; sessions persist through
  Chrome restarts and service-worker suspension (no reliance on in-memory timers).
- **Pressure profiles** — pick the "voice" that keeps you honest, from gentle encouragement to a
  deliberately theatrical "Ruthless Roaster," all tuned to be about the work, never the person.
- **Site blocking** — soft nudges or hard passcode-locked restriction on sites you choose, scoped
  to only the permissions you grant.
- **Friends & accountability** — add friends, share session activity (opt-in, event-type only —
  never site names or goal text), and send Producer Tags: short pre-recorded audio nudges instead
  of unmuting a call.
- **Study Rooms** — live audio/video co-working via LiveKit, decoupled from whether accountability
  features are in use.
- **Task Vault** — a lightweight local task list that feeds directly into session setup.
- **Friend-held unlock** — a locked site can only be reopened with a passcode, or by asking a
  friend to approve a temporary pass — a person holds the key, not an algorithm.

## Tech stack

- [WXT](https://wxt.dev/) + React 19 + TypeScript, Chrome MV3
- [Supabase](https://supabase.com/) (Postgres with row-level security, Auth, Storage, Realtime,
  Edge Functions) for the social/accountability backend
- [LiveKit](https://livekit.io/) for Study Room audio/video
- Anthropic's Claude (server-side only, via a Supabase Edge Function) for optional AI coaching
  lines; Resend for friend-approval emails
- Vitest + Testing Library for unit/component tests, Playwright for e2e

No third-party API key is ever shipped in the extension bundle — every external service is
called from a server-side Edge Function.

## Getting started

```bash
cd snufflestudy
npm install
cp .env.example .env   # fill in your own Supabase project values
npm run dev            # starts WXT; load .output/chrome-mv3-dev/ via chrome://extensions
```

Other useful commands (run from `snufflestudy/`):

```bash
npm run build     # production build -> .output/chrome-mv3/
npm run zip        # packages a .zip ready for the Chrome Web Store
npm run compile    # type-check only
npm test           # unit/component tests (Vitest)
npm run test:e2e   # Playwright end-to-end tests
```

## Privacy

SnuffleStudy's full privacy policy is published at
[chloewychan.github.io/SnuffleStudy/privacy-policy.html](https://chloewychan.github.io/SnuffleStudy/privacy-policy.html),
and the same content is available from the extension's own Options page once installed.

## License

ISC — see `package.json`.
