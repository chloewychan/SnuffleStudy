# SnuffleStudy V4 Scope Summary — Accessory Features

**Purpose of this document:** catalog the work that comes after `docs/V3_Scope_Summary.md` — real improvements, none of them required for the extension to be genuinely usable or deployable. V3's whole point is that nothing on this list should block shipping; everything here can land on whatever cadence makes sense once real users are actually on a deployment-ready build.

---

## Draggable persistent bunny

**What's asked:** put the actual bunny image on the screen — no animation for this version, a still placeholder the user can drag around, that stays where it's dropped. Clicking it opens the side panel.

**What already exists (confirmed by reading the code, not assumed):** the placeholder-art system this needs is already exactly as simple as it should be — `animationRegistry.ts` defines one static PNG per wellness state (`frameDurationMs: 0`, i.e. genuinely "no animation, just a still image," matching the architecture doc's own placeholder-asset design). But `SnufflesOverlay.tsx` only mounts that image inside the distraction-warning content-script overlay, gated to `classification === "BLOCKED"` — not a persistent, always-visible companion. `movementController.ts`, which computes a starting `{x, y}` per movement preference (`free`, `bottom-edge`, `bottom-only`, `static`, `hidden`), exists but has zero call sites anywhere in the app today — dead code, ready to be wired up rather than written from scratch.

**Build requirements, as specified:**
- Persist the bunny's position **centrally, per user, in viewport-relative terms** — not per tab, and not reset on every page load. `chrome.storage.local` is the natural fit, consistent with how the rest of the extension already stores state.
- **Constrain it inside the viewport** so a user can never drag it somewhere they can't get back to without reloading.
- **Use a drag threshold** (e.g., a few pixels of movement) so a small, accidental movement still registers as a click rather than eating the click-to-open gesture.
- **Clicking must open the side panel through an actual user gesture.** This is a real platform constraint, not a style preference: `chrome.sidePanel.open()` is documented to require a genuine user interaction — an action-icon click, a keyboard shortcut, a context menu, or "a user gesture on an extension page or content script." One wrinkle worth flagging now rather than discovering during implementation: the bunny lives in a content script, and it's genuinely unclear from Chrome's own documentation whether a click handled in a content script can call `sidePanel.open()` directly, or whether the call has to happen in the background service worker after a `chrome.runtime.sendMessage()` round trip — and if it's the latter, whether the user-gesture context survives that round trip at all. `PopupApp.tsx`'s existing `openSidePanel()` call works today because the popup is itself an extension page calling the API directly, in the same synchronous gesture — a content script may not have that luxury. Confirm the actual working pattern against current Chrome behavior at build time rather than assuming the popup's approach transfers unchanged.

**Why this is deferred rather than folded into V3:** an always-on content-script element is a meaningfully different risk profile than a warning that appears only when something's already gone wrong. It adds cross-site visual compatibility questions (host pages with their own aggressive `z-index` stacking contexts — the existing Shadow DOM already isolates the overlay's *styles*, per `overlayHost.tsx`, but doesn't guarantee stacking order against every possible host page), page zoom/scroll/resize interactions with a persisted absolute position, accessibility for an always-present draggable element, and the general "where did my bunny go?" class of edge case that a warning-only overlay never had to solve. None of that blocks the extension from being usable — it's exactly the kind of polish that benefits from being built against a stable, already-shipped V3 rather than racing to ship alongside deployment-readiness work.

**Priority within V4:** the more concretely scoped of the two named items here — no backend dependency, no new art assets, and it's wiring together two pieces that already exist in isolation. A reasonable first V4 task once V3 ships.

---

## Aggregate analytics dashboard

The History/Review screen already ships a real, filterable, browsable log of past sessions and events — built in v2, live-verified. This item is the layer on top: charts and trends (completion rate over time, average time-to-first-distraction, recovery-rate trends by pressure profile, and similar) synthesized from that same underlying data.

**Keep the existing History/Review UI as the useful baseline, and add trends only after real usage reveals the questions users actually ask.** Building aggregate charts before there's real session data to look at risks designing dashboards around guessed-at questions instead of the ones people actually have — the same reasoning that kept this out of v2's scope in the first place. Revisit this once V3 has been live long enough to have real usage patterns worth visualizing.

---

## Everything else

These are all valuable, but none should delay proving the core Chrome product works reliably for real friend groups — which is what V3 exists to prove. No fixed order; each is worth revisiting individually once there's a concrete reason to, not preemptively.

- **Push notifications (FCM)** — the delivery upgrade from polling for friend nudges and events. Stays conditional on polling latency actually becoming a real, repeated complaint once real users are on it, rather than a theoretical one.
- **Multi-device sync** — full offline conflict resolution across devices. Today's guarantee ("don't break when offline") already holds and is sufficient for a single-device user.
- **Cross-browser support** — Chrome MV3 only today; a real port effort (Firefox's WebExtensions differences, Safari's App Extension model) once there's demand to justify it.
- **Play Mode expansion** — mini-games, cosmetics, food/toys/room interaction beyond what already exists. Secondary to the product's core identity by design (per `docs/Draft1_Architecture_Overview.md`'s own framing: cosmetics "add personality" but shouldn't "carry the entire motivation system").
- **Additional Snuffles personalities** beyond the six seeded pressure profiles.
- **Real hand-drawn animation frames and a Figma-sourced visual design pass** — today's placeholder art (one static PNG per wellness state) is exactly what the draggable-bunny item above builds on top of, not a replacement for it. The architecture's own asset-registry design means swapping in real frames later is a registry change, not a rewrite of any overlay or session logic.

---

## Sequencing note

Nothing in this document blocks anything else in it — these can be picked up in whatever order matches real user feedback once V3 ships. The draggable bunny and the analytics dashboard are the two most concretely scoped if a next step is wanted immediately after V3; everything in "Everything else" is genuinely opportunistic, triggered by an actual signal (a real latency complaint, a real cross-browser request, real usage data worth charting) rather than a fixed date.
