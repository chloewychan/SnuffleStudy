# V3.4 Task 6 report: Require the current password before changing it

**Branch:** `v3.4` (already checked out — confirmed with `git branch --show-current` → `v3.4`, and `git log --oneline -5`, top: `12206d1 feat(v3.4-task6): add standalone password_set_at migration`).

**This is a finish-the-task run, not a from-scratch one.** A previous agent's connection dropped mid-response after landing one commit (the migration) and partially editing `profileApi.ts` (interface/row-type/`toProfile()` changes only — `markPasswordSet()` itself was not yet written). Everything else — `markPasswordSet()`, `shared/messages.ts`, `messageRouter.ts`, `AccountPage.tsx`, tests, live verification, this report — had not been started. I picked up from that state.

## Pre-flight verification against the live repo

Ran `git diff snufflestudy/src/infrastructure/backend/profileApi.ts` first, per the handoff instructions, and confirmed exactly what was claimed: `Profile.passwordSetAt`/`ProfileRow.password_set_at` added, `toProfile()` mapping added, `markPasswordSet()` absent. Read Task 6's full block (`docs/implementation_plans/V3.4_Implementation_Plan.md`, lines 1644–1805) and `V3.4_Scope_Summary.md` Section 1 item 2. Read every file to be touched in full before editing: `profileApi.ts`, `shared/messages.ts`, `background/messageRouter.ts` (its `AUTH_SET_PASSWORD`/`AUTH_SIGN_IN_PASSWORD`/`PROFILE_GET_MINE` cases, to confirm the `signInWithPassword` return-shape convention and the `profileApi` import already present), `options/pages/AccountPage.tsx` (full file — found it already has a `passwordSetAt` state variable from v3.3 Task 14, used only to show a "Password updated." confirmation, not yet wired to a profile fetch).

Confirmed independently (not just trusted from the handoff) that migration `20260815000043_v3.4_profiles_password_set_at.sql` is applied and `profiles.password_set_at` exists, via the live-verification script below (its own precondition check reads this column directly through the service-role client before any `AUTH_SET_PASSWORD` logic runs). Did not re-touch the migration file itself — no discrepancy found in it.

## What was inherited vs. what I did

**Inherited (untouched by me except where noted):** the migration (commit `12206d1`), and `profileApi.ts`'s `Profile`/`ProfileRow`/`toProfile()` edits.

**What I built:**

- **`snufflestudy/src/infrastructure/backend/profileApi.ts`** — added `markPasswordSet()` verbatim per the plan's Interfaces block (upsert `{ user_id, password_set_at }`, `onConflict: "user_id"`, via `requireUserId()`, throws on error), with the plan's own explanatory comment (why it's separate from `saveMyProfile()`) preserved, matching the comment density the previous agent's diff already established on the interface fields.
- **`shared/messages.ts`** — `AUTH_SET_PASSWORD`'s payload gained `currentPassword?: string`; extended the existing comment block to explain when it's read/ignored.
- **`background/messageRouter.ts`** — rewrote the `AUTH_SET_PASSWORD` case exactly per the plan's code block: `profileApi.getMyProfile()` → if `passwordSetAt` truthy, require `currentPassword` (else `{ok:false, error:"Current password is required."}`), resolve the session email via `supabase.auth.getSession()`, verify via `supabase.auth.signInWithPassword()` (matches `AUTH_SIGN_IN_PASSWORD`'s exact call/return-shape convention immediately above it in the same file — same `{ data, error }` destructure, same `if (error) return {ok:false, error: error.message}` shape, adapted here to a fixed user-facing string since a raw Supabase "Invalid login credentials" message would be a confusing thing to surface as "your current password is wrong"), reject on mismatch; only then `updateUser({password})`, then `await profileApi.markPasswordSet()`, then `{ok:true}`. Extended the pre-existing signed-in-precondition comment rather than replacing it.
- **`options/pages/AccountPage.tsx`**:
  - New `PROFILE_GET_MINE`-backed `useEffect` (fires once `session` is set, alongside the existing `loadFriends` effect) that sets `passwordSetAt` from the fetched profile. Reused the pre-existing `passwordSetAt` state variable rather than adding a second one — it already existed (v3.3 Task 14) purely as a post-submit "Password updated." confirmation flag; this task makes it also reflect the server's actual state on load, and continues setting it to `Date.now()` on a successful `AUTH_SET_PASSWORD` (unchanged behavior, and it correctly flips a first-time set into "current password now required" for the very next change without waiting on a re-fetch).
  - New `currentPassword`/`setCurrentPassword` state.
  - JSX: conditional "Current password" field (`passwordSetAt !== null`), required, positioned above "New password" per the plan.
  - Submit-disabled logic extended with `(passwordSetAt !== null && !currentPassword)`.
  - `handleSetPassword`: sends `currentPassword` in the payload only when `passwordSetAt !== null` (spread-conditional, not an always-present possibly-empty field); clears it alongside `newPassword`/`confirmNewPassword` on success; leaves it untouched on failure. Verified this page's "don't wipe input on failure" convention is real (not assumed) by reading `handleSetPassword`'s pre-existing catch/if-not-ok paths — none of the three password fields were ever cleared there before this task, only on the success path.
  - Also reset `currentPassword` alongside the other password fields in `handleSignOut`/`handleDeleteAccount`, matching how `newPassword`/`confirmNewPassword`/`passwordSetAt` were already reset in both.
- **Tests updated/added:**
  - `profileApi.test.ts`: `sampleRow`/`sampleProfile` fixtures gained `password_set_at`/`passwordSetAt`; added a `toProfile()` mapping test (non-null timestamp → epoch millis) and a full `markPasswordSet` describe block (upsert shape via fake timers, error propagation, not-signed-in guard).
  - `messageRouterAccountability.test.ts`: updated the two existing `AUTH_SET_PASSWORD` tests to mock `profileApi.getMyProfile` returning `null` (the "no password yet" branch, matching pre-Task-6 behavior plus the new `markPasswordSet` call) and added a new describe block covering the three "password already set" branches — missing `currentPassword` rejected without touching `updateUser`; wrong `currentPassword` rejected via a mocked `signInWithPassword` failure, `updateUser` never called; correct `currentPassword` succeeds and calls `markPasswordSet`. Also added `passwordSetAt: null` to the pre-existing `sampleProfile` fixture in the same file's `PROFILE_*` describe block (now a required field on the type).
  - `AccountPage.test.tsx`: added a `mockSignedInWithExistingPassword()` helper and four new tests — no field when `passwordSetAt` is null; field renders/required and gates submit-disabled when it isn't; `currentPassword` included in the `AUTH_SET_PASSWORD` payload and cleared on success; "Current password is incorrect" surfaces without clearing the field on failure.
  - Fixed three now-broken `Profile`-typed fixtures that were missing the new required field and would otherwise fail `tsc`/`toEqual`: `useDisplayNames.test.ts`, `BunnyTab.test.tsx`, `alarmHandlers.test.ts`.

## What I verified

**`cd snufflestudy && npx vitest run`** — 84 test files, **897 tests, all passing** (was 897 both before and after the final `alarmHandlers.test.ts` type fix — no regressions, new tests included in that count).

**`cd snufflestudy && npm run compile`** — clean, zero errors. One real compile failure surfaced and was fixed along the way: `alarmHandlers.test.ts` constructed a bare `Profile` object literal missing the now-required `passwordSetAt` field (TS2741); added `passwordSetAt: null`.

**Live verification against the real dev Supabase project** (`WXT_SUPABASE_URL` = `uykpyjnubzuzhgpkvjwu.supabase.co`, confirmed from `.env`), via a new script, `snufflestudy/scripts/verify-password-check.mjs` (pattern-matched against `verify-friendships.mjs`'s structure/conventions — `record()`/`results[]` summary, `dotenv/config`, ephemeral auto-confirmed test account, explicit cleanup + `listUsers()` confirmation, non-zero exit on any failure).

What it exercises for real vs. simulates (documented in the script's own header): every Supabase Auth/Postgres call is real — `admin.auth.admin.createUser`, `signInWithPassword`, `updateUser`, and a `profiles` upsert as the caller's own authenticated client (the exact call `markPasswordSet()` makes, going through the real RLS policy, not a service-role bypass). What's simulated is only the `chrome.runtime` message-passing plumbing itself — there's no `chrome.*` runtime in a plain Node script (same limitation `verify-friendships.mjs` already notes for `chrome.notifications`). In place of that, the script inlines `runAuthSetPassword()`, which issues the identical sequence of supabase-js calls in the identical branch order `messageRouter.ts`'s real case does, rather than a hand-waved approximation.

Ran: `node scripts/verify-password-check.mjs`. **All 15 checks passed**, including the negative case:

- Fresh test account, `profiles.password_set_at` confirmed `null` before any call.
- First `AUTH_SET_PASSWORD` with no `currentPassword` succeeds (no password ever set yet); `password_set_at` becomes non-null.
- **Wrong-current-password negative case:** same account, now with a password, calls again with a wrong `currentPassword` → rejected with exactly `"Current password is incorrect."`; proved the password is unchanged by signing in with the OLD password (succeeds) and the rejected NEW password (fails).
- Same account, correct `currentPassword` → succeeds; sign-in with the NEW password now works, the OLD one now fails.
- Cleanup confirmed via `listUsers()` — the test account no longer exists.

**Definition of done, item by item:**
- No-password account, no `currentPassword`, succeeds, `password_set_at` set → live-verified (checks 1–6 above).
- Wrong-`currentPassword` negative case fails with the exact message, `updateUser` never reached, password unchanged → live-verified (checks 7–10).
- Correct `currentPassword` succeeds, new sign-in works, old one doesn't → live-verified (checks 11–14).
- `AccountPage.tsx` renders no field when `passwordSetAt` is null, renders+requires it otherwise → verified via the component test suite (not just JSX reading), per item 8 of the task instructions: the four new `AccountPage.test.tsx` tests above.

## Judgment calls

- **Reused the existing `passwordSetAt` state variable in `AccountPage.tsx` instead of introducing a second one.** The plan doesn't mention this state already existed (it predates Task 6, from v3.3 Task 14's "Password updated." confirmation). Loading it from `PROFILE_GET_MINE` on top of its existing post-submit-`Date.now()` behavior satisfies the plan's contract (gate the field on server truth) while also giving a nicer incidental property: a first-time set immediately requires a current password on the very next attempt, without waiting on a re-fetch.
- **`AUTH_SIGN_IN_PASSWORD`'s return-shape convention, applied to the verification call:** matched its exact `{ data, error }` destructure and early-return-on-error shape, but return a fixed `"Current password is incorrect."` string rather than passing through Supabase's raw error message — a deliberate departure from `AUTH_SIGN_IN_PASSWORD`'s own message pass-through, since surfacing Supabase's actual wording (e.g. "Invalid login credentials") in a "change your password" form reads as a confusing non-sequitur to a user who isn't trying to sign in. This matches the plan's own code block exactly (it hardcodes this same string), so it's not really a discretionary call — just noting the rationale.
- **`PROFILE_GET_MINE` fetch effect placement:** fired once `session` resolves, as its own `useEffect`, parallel to (not merged into) the existing `loadFriends` effect — the plan explicitly left this sequencing open ("fired once, alongside the existing `AUTH_GET_SESSION` effect, or right after `session` resolves — either is fine").
- **Extra test coverage beyond the minimum:** added a `profileApi.ts` `toProfile()` mapping test and a full `markPasswordSet()` unit-test describe block, and expanded router-level coverage to all three "password already set" branches (missing/wrong/correct), not just the two happy-path cases the previous agent's inherited code implied. This wasn't explicitly requested but follows the existing file's own density of coverage for sibling functions (`saveMyProfile`, `getMyProfile` each have 4–5 tests; `markPasswordSet` had zero before this).

## What's still open

Nothing outstanding within Task 6's own scope — every Definition of Done item is live-verified or test-verified above. Left `HARD_BLOCK_SET_PASSCODE`'s existing old-passcode check untouched, per the plan's explicit scope carve-out (structurally identical idea, different verification mechanism, not this task's concern). Task 7 (create-account completion step, the plan's own stated reason Task 6 was sequenced before it) has not been started — its `AUTH_SET_PASSWORD` call site in `SignInForm.tsx` already omits `currentPassword` entirely, which is exactly the contract Task 6 leaves for it to build against.
