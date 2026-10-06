# SnuffleStudy (extension)

The Chrome extension itself — see the [repo root README](../README.md) for what SnuffleStudy is
and what it does. This README covers development only.

Built with [WXT](https://wxt.dev/) + React 19 + TypeScript, targeting Chrome MV3.

## Setup

```bash
npm install
cp .env.example .env   # fill in your own Supabase project values
```

`.env` vars prefixed `WXT_` are bundled client-side; `SUPABASE_SERVICE_ROLE_KEY` is Node-only
(used by scripts, never by the extension bundle).

## Commands

| Command              | Purpose                                                  |
| --------------------- | --------------------------------------------------------- |
| `npm run dev`         | Dev build with HMR. Load `.output/chrome-mv3-dev/` via `chrome://extensions` → "Load unpacked". Auto-launch is disabled (see `wxt.config.ts`) — load manually. |
| `npm run dev:firefox` | Same, targeting Firefox.                                   |
| `npm run build`       | Production build → `.output/chrome-mv3/`.                 |
| `npm run zip`         | Packages a `.zip` ready for Chrome Web Store submission.  |
| `npm run compile`     | Type-check only (`tsc --noEmit`).                          |
| `npm test`            | Unit/component tests (Vitest).                            |
| `npm run test:e2e`    | Builds, then runs Playwright end-to-end tests.             |

## Project layout

- `entrypoints/` — WXT entrypoints (background service worker, content script, sidepanel,
  options, locked page).
- `src/domain/` — pure business logic (sessions, pressure profiles, tasks, site rules) with no
  browser or network dependencies.
- `src/infrastructure/` — adapters over `chrome.*` APIs, Supabase, LiveKit, IndexedDB.
- `src/background/`, `src/sidepanel/`, `src/options/`, `src/content/` — presentation layer per
  surface.
- `src/shared/` — cross-surface UI and hooks.
- `supabase/` (repo root) — Postgres migrations and Edge Functions for the backend.

## Manifest notes

Permissions and other `manifest.json` fields are defined in `wxt.config.ts`, with a few
entrypoint-driven exceptions documented inline there (e.g. `options.open_in_tab` lives in
`entrypoints/options/index.html`'s `<meta>` tag because WXT's own auto-generation would otherwise
override it). Read the comments in `wxt.config.ts` before changing permissions or
`web_accessible_resources` — several are QA-discovered fixes for real Chrome MV3 behavior, not
arbitrary choices.
