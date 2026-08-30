# SnuffleStudy — Devpost Application Strategy

*Drafted from the actual codebase, scope summaries, and implementation history (through V4.2 in progress), not just the existing devpost draft.*

---

## 1. Problem Statement (target-market framing)

**Target market:** high school and college students who already study "together" over a call — Discord study rooms, Zoom co-working sessions, FaceTime body-doubling — because in-person group study never survives real schedules. This is squarely inside the hackathon's own eligibility pool (high school + college), which makes the pitch land harder for judges: you're not describing a hypothetical user, you're describing the room.

**The problem, stated for that audience specifically:**

Group study works because of social pressure — someone can see you're on TikTok instead of your notes. Since COVID normalized "coworking" calls, that group has gone virtual, and the accountability went with it. Students keep cameras and mics off by default — public libraries, dorm rooms with roommates asleep, phone battery, just not wanting to be watched — and once the camera's off, a study call is functionally the same as studying alone with extra Discord notifications. The group didn't fail; the mechanism that made the group work (visibility) quietly disappeared while everyone kept calling it "studying together."

Existing tools solve half of this each: site blockers (Cold Turkey, Forest) fight distraction but remove the *social* half entirely — no one else's opinion is involved, so it's exactly as easy to disable as any personal willpower tool. Coworking/body-doubling apps (Focusmate, Study Together) restore a person on the other side of the call but don't touch the actual distraction mechanism — you can still be visibly on your phone with nothing stopping you, and there's no lightweight way to say "hey, focus" without fully unmuting and interrupting.

**SnuffleStudy's answer:** decouple accountability from the camera. The extension itself watches for distraction (tab-switching to blocked sites, inactivity) and tells your friend group when it happens — so the group *knows* the moment someone drifts, without anyone needing to keep video on. Friends respond with Producer Tags (silent pre-recorded audio nudges) instead of unmuting, so accountability doesn't cost the whole room a conversation. And when nudges alone aren't enough, a friend — not an app store, not a paywall — holds the actual key: a passcode to unlock a blocked site, requested and approved between real people who already agreed to hold each other to it.

---

## 2. Strongest Selling Points

- **Accountability without cameras.** This is the actual insight, not a generic "study app": the extension is the eyes so your friends don't have to keep a camera on to know you're off-task. Everything else (Producer Tags, nudges, passcodes) is downstream of solving this one specific, real, and previously-unaddressed gap in coworking tools.

- **A friend holds the key, not an algorithm.** Hard-mode restriction requires a passcode *your friend* has — the same trust model as a parent holding a kid's Screen Time code, but between peers who chose each other. That's a meaningfully different (and more honest) accountability mechanic than "the app decides when you've earned a break."

- **Privacy is enforced in the database, not just hidden in the UI.** Every single piece of data a friend can see (current site, distraction count, goal text, full history) has its own default-off toggle, and it's enforced with Postgres row-level security — meaning even if someone tampered with the client, the server itself refuses to hand over data the toggle says shouldn't leave your account. Most student hackathon projects claim "privacy-respecting"; this one can show the RLS policy that makes it true.

- **Two real security primitives most hackathon projects don't bother with:** salted-hash, rate-limited passcodes (both the permanent hard-block passcode and the single-site temporary pass) instead of plaintext, and zero third-party API keys shipped in the extension bundle — Anthropic, Supabase, LiveKit, and Resend are all called from server-side Edge Functions, so nothing in the published extension can be extracted and abused.

- **Local-first, not "requires our backend to function."** Core timers, the Task Vault, and distraction detection run entirely on `chrome.storage`/IndexedDB — the app is fully usable offline or if the backend is ever down. The social layer (friends, nudges, rooms) is additive on top, not load-bearing for the base product. That's a real architectural decision, not a fallback excuse.

- **A mascot that's actually earning its place, not a slapped-on Duolingo-owl clone.** Snuffles is hand-drawn in Procreate, the UI is hand-built in Figma (explicitly *not* AI-generated), and the pressure-style system means the same bunny can be gently encouraging or a "Ruthless Enforcer" depending on what a student actually responds to — while every generated line is constrained to be work-ethic-based, never a personal attack. That's a deliberate behavioral-design choice, not flavor text.

- **AI used narrowly and defensibly.** Claude generates the coaching one-liners (via a Supabase Edge Function, key never exposed) with an instant fallback to a pre-written line if the network is slow — AI enhances a small, well-scoped surface instead of being the whole pitch, which reads as more credible to judges than "AI-powered" plastered over everything.

- **This is a real, evolving product, not a hackathon-week sprint.** The commit history and version docs (V1 → V4.2) show sustained iteration — a pairwise friendship model rebuilt from a group mechanic, three duplicate request systems consolidated into one, a real Figma design pass being integrated screen-by-screen right now. That maturity is a legitimate differentiator versus a project built in the last 48 hours, and it's demonstrable (screenshots, Figma frames, and a live git history), not just claimed.

---

## 3. Most Technically Challenging Aspects

1. **Surviving MV3 service worker suspension.** Chrome can kill and restart the background service worker at any time, meaning nothing can safely live in memory — every session timer had to be rebuilt around persisted real timestamps plus `chrome.alarms` instead of `setTimeout`/in-memory counters, so a session picks up correctly even if the worker was suspended mid-session.

2. **Rebuilding the friend model without breaking every permission check that depended on it.** The original "friending" was actually a hidden group mechanic (`friend_groups`/`group_memberships`) that nearly every RLS policy in the app routed through. Replacing it with real pairwise friendships (`friendships` table + an `are_friends()` SECURITY DEFINER helper) meant touching the majority of the app's row-level-security surface in one pass — profiles, nudges, Producer Tags, study rooms and their invitees, and every friend-approval flow — without a data migration, since a single missed call site is a silent security hole, not just a bug.

3. **Consolidating three near-duplicate request systems into one polymorphic mechanism.** Unlock requests, temporary single-site passcode requests, and session-end-early requests each started as their own table with hand-copied RLS and their own approval panel. Unifying them into one `friend_requests` table (a `kind` discriminator plus a handful of kind-specific nullable columns) with one shared RLS policy set and one approver UI is the kind of schema-design problem that's easy to get wrong in a way that only shows up as a security or race-condition bug later — first-responder-wins resolution had to be preserved exactly across the merge.

4. **Real cryptographic hygiene for the passcode system**, not just a config flag: salted hashes with rate-limited guessing for both the permanent hard-block passcode and the single-site temporary pass, plus a remote-approval flow (a friend approves a temp pass without ever learning the account's permanent one).

5. **Zero-secrets-in-the-extension architecture across four third-party services simultaneously.** Anthropic, Supabase, LiveKit, and Resend all needed to be callable from a Chrome extension without a single API key ever shipping inside the installable bundle — every call routes through a Supabase Edge Function acting as a proxy/adapter, and each service is isolated behind its own small adapter file specifically so a provider swap later touches one file instead of the app.

6. **A persistent UI element surviving Chrome's own lifecycle rules.** The planned draggable, always-on-screen Snuffles has to keep a `chrome.sidePanel.open()` call inside a genuine user gesture — a real, poorly-documented platform ambiguity about whether a content-script click can call that API directly or has to round-trip through the background service worker while somehow preserving gesture context — plus staying inside the viewport, tolerating page zoom/scroll, and not fighting host-page `z-index` stacking (mitigated via Shadow DOM isolation, but not fully solved by it).

7. **Lifting live call state out of a tab-scoped component into a persistent app-shell context.** The Study Room video/audio session (LiveKit) originally tore down on tab switch because it lived inside the tab's own component lifecycle; making it survive navigating to other tabs required pulling that state up to the shell level without breaking the existing join/leave cleanup logic.

8. **Distinguishing "activity-only" tracking from full site-permission tracking as two real, separately-scoped tiers** — not a UI toggle, but two genuinely different Chrome permission grants, so a user who's uncomfortable sharing browsing history can still get baseline accountability without the extension ever seeing which sites they visit.

---

## 4. Other Material Worth Including

**Map straight onto the judging rubric** (Devpost judges are literally scoring against these categories — mirror the language):
- *Execution & Build Quality (30%)* — cite the layered domain/infrastructure/presentation architecture explicitly; it's why the social layer could bolt onto the offline-first core without a rewrite. Mention the version history (V1 → V4.2) as evidence of iteration, not a one-shot build.
- *Originality (25%)* — lead with "accountability without cameras" and Producer Tags; this is the most defensibly novel mechanic in the project.
- *Value & Impact (20%)* — group study is close to universal among students; the "camera-off kills accountability" problem is one every judge who's used a Discord study call will personally recognize.
- *User Experience (15%)* — hand-drawn art, warm/constructive-not-punitive tone across all pressure styles, and (once V4.2 lands) a real Figma-designed interface rather than default component styling.
- *Presentation Quality (10%)* — you already have real assets for this: the `images/Devpost Image Gallery` folder has screenshots and page mockups, and `images/Figma Frames` has clean per-page designs (Bunny, Friends, Settings, Study, Study Session) ready to drop straight into the submission's image gallery.

**Prize targeting:**
- **Real Impact Award** is the best fit to lead with — "clearest real-world use and tangible value" maps directly onto the group-study-accountability problem statement.
- **Boldest Idea Award** — pitch Producer Tags / camera-off accountability as the original concept, not "another blocker extension."
- **Limit Breaker Award** (overall standout) — the strongest case is technical: RLS-enforced privacy, zero-key architecture, and the MV3 resilience work are all things a judge can verify are real by reading the code, not just claims in the writeup.
- Rising Builder likely isn't the right fit given the project's clear engineering maturity — don't undersell the team by reaching for it.

**Team/roles:** the submission requires listing team members and roles — worth deciding now whether this is solo or a team, since "Rising Builder" and general narrative framing shift depending on that.

**On embellishing — one genuinely low-risk option:** the persistent, drag-anywhere Snuffles companion (item 4 in `V4_Scope_Summary.md`) is *not* vaporware to claim — the placeholder art system (`animationRegistry.ts`) and the positioning logic (`movementController.ts`) already exist in the codebase with zero call sites, i.e., the hard parts are built and just unwired. This is the feature that would most tie the pitch together narratively: right now the write-up describes Snuffles as something that shows up during warnings, but "Snuffles lives on your screen as a real companion, not just a warning popup" is a stronger, more memorable hook for a demo video — and it's close enough to real that you could plausibly wire it up before the deadline rather than only faking it. If time runs out, it's honest to describe it as "shipping" in the roadmap section rather than the features list, since the underlying pieces demonstrably exist.

**A framing gap worth closing before submission:** the existing draft's "Solution Overview" undersells the *soft-mode nudging* escalation logic and the fact that tracking has two consent tiers — both are strong "we thought about trust, not just features" details that judges scoring Value & Impact and UX will respond to if surfaced explicitly rather than left implicit in a feature list.

**Timing note:** submission deadline is August 30, 2026, 9:00 PM PDT — tomorrow relative to today's date. V4.2 (the real Figma-design integration into the actual extension) is 4 of 14 tasks complete as of the latest commit. Worth deciding now whether to push to finish more of the visual re-skin before the deadline, or to lean on the existing Figma frames/mockup screenshots (which are polished and ready) to carry the visual story in the submission regardless of how much of the re-skin has shipped in the running extension.
