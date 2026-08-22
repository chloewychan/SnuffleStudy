# SnuffleStudy — Devpost Submission Draft

Rewritten to actually sound like us, and broken into jot notes wherever a wall of text wasn't doing us any favors. Copy each section into the matching Devpost field — smooth out any bullet into a sentence if a field reads weird as a list.

---

## Project name

SnuffleStudy

## Elevator pitch (200 chars max)

> SnuffleStudy: consensual peer pressure for studying — set a goal, hop into a study room with friends, and let a bunny (and your friends) call you out.

*(150 characters. Shorter backup: "A Chrome extension that turns studying into a group sport: set a goal, join a study room with friends, and let Snuffles call out every distraction." — 147 characters.)*

---

## Project Story

### Inspiration

- My friends and I have never struggled to care about school — staying motivated to actually study together is what's always been hard
   - Elementary school: COVID lockdown killed group study before it even really started
   - High school: schedules got busy, and coming out of the pandemic's "virtual hangout" burnout, video calls just never stuck as a study habit
   - University: co-op terms and different school schedules mean we're rarely even in the same city anymore
- Even studying "together" (in person or on a call) it's way too easy to quietly drift off task and have nobody notice
- The annoying part: if you're studying somewhere public — library, café — you usually can't have your camera or mic on. Which kills the one thing that actually made a call feel like accountability

### What it does

- Centred around a study timer, but that's just the anchor
- **Task Vault** — decide what you actually need to get done, break it into pieces, start a session from any one piece
- Snuffles (the bunny) and the hand-drawn, playful UI make it something you actually want to open, not just another blocker extension
- The real innovative feature: **Study Rooms with friends**
   - Follow friends, add them to a room, study together
   - Camera and mic are optional — can't be on camera? Send a **Producer Tag** instead, a pre-recorded audio nudge that just says "hey, I'm still here, get back to it"
   - Go quiet for too long, or wander onto a restricted site, and your friend group gets notified — accountability doesn't stop just because the call's muted
- Restricted sites work two ways: soft mode nudges you with a warning that's actually written around *your* real goal (not a generic "stop scrolling"), hard mode locks you out completely until a passcode gets entered

### How we built it

- Chrome extension, Manifest V3, TypeScript + React, built with WXT
- Real layered architecture from day one — domain / infrastructure / presentation, not one giant popup.js — which is exactly what let the whole friend/social layer bolt on later instead of forcing a rewrite
- Local-first: `chrome.storage` + IndexedDB, so the core app works fully offline even if the backend's down
- Backend on **Supabase** — Postgres, Auth, Realtime, Storage, Edge Functions — friend groups, live status, nudges, all locked down with row-level security
- Study Room video calls: **LiveKit**
- AI-generated coaching messages: **Anthropic's Claude API**, called from a Supabase Edge Function so the key never ships inside the extension — falls back instantly to a pre-written line if the network's slow or down
- Temporary passcode emails: **Resend**
- Designed first in **Figma** — Snuffles' whole look, and the rest of the UI's soft handmade feel, came from there before we wrote a single component

### Challenges we ran into

- Big one: letting an extension watch what sites you're on and tell your friends about it is a trust problem before it's a feature
   - Two tracking tiers — activity-only asks for zero site permissions at all, detailed only asks the moment you actually turn it on
   - Every piece of data a friend can see is its own toggle, off by default, enforced with row-level security in the database — not just hidden in the UI, so it can't leak even if someone messes with the client
- Soft mode vs. hard mode
   - Soft mode nudges you, you can still keep going
   - Hard mode locks you out completely — no in-app escape hatch, only a passcode
- Passcodes, two kinds
   - A permanent one you set once and hand to a friend (not yourself) — same idea as sharing a Screen Time code
   - A temporary, single-site one a friend can approve remotely, for the "I swear I need this one page" case
   - Both stored as salted hashes with rate-limited guessing, never plaintext
- No API key — Anthropic's, Supabase's, LiveKit's, Resend's — ever ships inside the extension itself. Everything goes through a server-side function that holds the real secret

### Accomplishments that we're proud of

- Hand-designing the full UI in Figma to get that handmade, friendly vibe — Snuffles specifically was drawn to feel like an actual plush toy, not a generic app mascot
- Getting a real, *live* friend-accountability system — live status, nudges, remote unlock approval, daily digest — working on top of an app that still works completely offline if you never add a single friend. The social layer bolted on cleanly instead of turning into a rewrite, because of that architecture call up front

### What we learned

- MV3 service workers can get suspended at any moment — you can't trust anything sitting in memory, so every timer had to be rebuilt around real timestamps and `chrome.alarms`
- Saying a feature is "privacy-respecting" and actually enforcing it at the database layer (not just hiding it in the UI) are two very different amounts of work
- Isolating every third-party service — Supabase, LiveKit, the Claude API — behind its own small adapter made this way less stressful to build. Swapping a provider later touches one file, not the whole app

### What's next for SnuffleStudy

- A real, persistent Snuffles you can drag anywhere on your screen and click to open your side panel (right now he's just a placeholder image that shows up during warnings)
- An actual analytics dashboard on top of the session history we already track
- Push notifications, so nudges arrive instantly instead of on a polling interval
- More Snuffles personalities/pressure styles, and a bigger Play Mode — mini-games, cosmetics
- Multi-device sync, and eventually getting off Chrome-only
- Actually publishing it: privacy policy, account deletion, a real Chrome Web Store listing

---

## Built With

```
typescript, react, wxt, vite, chrome-extensions, manifest-v3, chrome-storage-api,
indexeddb, supabase, postgresql, supabase-auth, supabase-realtime,
supabase-edge-functions, supabase-storage, livekit, anthropic, claude-api,
resend, chrome-alarms-api, chrome-idle-api, declarativenetrequest, vitest,
playwright, figma, node-js
```

That's 25 — if you want to swap any in, `node-js` and `chrome-idle-api` are the easiest to drop first.

---

## "Try it out" links

- **GitHub repo, as the main link:** `https://github.com/chloewychan/SnuffleStudy` — give the README a quick "how to run it" bit before you submit (`npm install`, `npm run build`, load `.output/chrome-mv3/` as an unpacked extension). Judges will go straight to the repo, so it's worth having a real build-and-load path there.
- **A second link if you've got one** — a quick Loom of loading the unpacked extension, if you don't want people to have to build it themselves just to see it run. Skip this if your demo video already covers it.

---

## Image gallery

15 images max, 3:2 ratio. Rough order that tells the story:

1. Welcome screen — the "consensual peer pressure" framing, before anything else
2. Sign-in step — showing the "sign in to use friends, rooms, nudges, approvals..." copy
3. Pressure-style picker — proves there's real range, not one tone
4. Session setup — a specific goal typed in, not "study for an hour"
5. Snuffles overlay mid-warning — the AI line that references the actual goal
6. Task Vault — a task broken into pieces, one started as a session
7. Friend Group panel — live status + a nudge, so the social layer is obviously real
8. A Study Room — video call with two people in it, your strongest shot
9. Producer Tags — the record/send UI, your most novel single feature
10. Daily digest card — "Bob was really locked in today"
11. History/Review screen — proves this isn't a one-session demo toy
12. Snuffles character art — the actual hand-drawn bunny illustrations already sitting in `images/` (`Bunny Standing.png`, `Bunny and Book.png`) — worth including as a design-process beat

---

## Video demo link

2–3 minutes, leading with the actual problem, not a feature list:

1. **Open on the problem** (10–15s) — the studying-alone-or-on-a-muted-call pain, said out loud instead of written
2. **Onboarding → sign-in → goal setup** (20–30s)
3. **The core loop** (30–40s) — start a session, visit a restricted site on purpose, show Snuffles' warning firing with the goal-specific line, recover
4. **Study Rooms** (30–40s) — the headline feature, give it the most time. Join with a second account if you can. If mic/camera's off, this is the natural spot to show a Producer Tag instead
5. **Accountability beyond the call** (15–20s) — a nudge landing, or the daily digest
6. **Close** (10s) — Task Vault or History as an "and it remembers everything" beat, out on the tagline

Two things worth doing: shoot the Study Room bit with two real signed-in accounts if you can — a single-account mockup won't actually prove it works, and that's the one part judges will want to see for real, not hear described. And say "consensual peer pressure" out loud somewhere in there — it's the clearest way to say what makes this different from a generic focus timer, and it's easy to lose if the video jumps straight into features.
