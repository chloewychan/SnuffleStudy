# V3.2 Task 8 report: Deployment readiness work

**Branch:** `v3.2` (off `main`), confirmed with `git branch --show-current` (`v3.2`) and
`git log --oneline -10` (top: `b9ed64a` Task 7, `435df23` Task 6, `27e5f80` Task 5, `84db217` Task 4,
`aff7d73` Task 3, `3f95e94` Task 2, `25b81d7` Task 1, `c120784` Task 0) before starting; did not
create a new branch. Did not attempt to apply either of Tasks 5/6's pending migrations
(`20260815000030`, `20260815000031`) or this task's own new migration to the live database — this
sandbox's write-safety classifier blocks mutating connections, per the same constraint documented
in the Task 5/6 reports and the dispatch for this task.

## Pre-flight verification against the live repo

Per the workflow doc and this task's own instructions, verified the plan's Task 8 table/feature
lists directly against the real repo rather than trusting them:

- **Table list correction (real finding, not assumed):** grepped every `create table` across all
  32 migration files in `supabase/migrations/`. The plan's Task 8 deliverable text names twelve
  tables with a column referencing `auth.users(id)` — but the real, complete set is **fourteen**:
  the plan's twelve plus `nudges` (`20260815000007_v2_nudges.sql`, added by a later v2 task) and
  `coaching_message_requests` (`20260815000014_v2_coaching_message_rate_limit.sql`). Both have
  live user-id columns (`nudges.sender_user_id`/`recipient_user_id`; `coaching_message_requests.
  user_id`). The new migration covers all fourteen.
- **No `on delete cascade` anywhere:** grepped every `references`/`on delete` clause across every
  migration — zero hits for any cascade/set-null FK action. Every FK in this schema is Postgres's
  default (NO ACTION). This directly contradicts an assumption the dispatch flagged as worth
  checking ("if `ON DELETE CASCADE` is already set... deleting the `auth.users` row alone might
  already cascade correctly") — it is **not** set anywhere, so `delete_account_data` has to do
  every table's cleanup explicitly, in FK-safe dependency order, before `auth.users`' own row can
  be removed.
- **`friend_groups`/`study_rooms` ownership, the plan's own flagged judgment call:** read
  `20260815000028_v2_group_leave.sql` in full (the only existing precedent for "what happens when
  an owner-referencing row's owner goes away"). It explicitly documents "there is no
  ownership-transfer mechanism anywhere in this schema" and accepts a departed owner's
  `owner_user_id` staying stale-but-valid — but that precedent only works because the referenced
  `auth.users` row still exists in that scenario (the owner merely left the group, they weren't
  deleted). Account deletion is a different situation: the referenced row is about to stop
  existing, so a stale `owner_user_id` becomes an actual dangling-FK problem, not just a semantic
  one. Also grepped every `for update`/`for delete` policy naming `study_rooms` — **none exist** (no
  client-facing close/transfer mechanism for a room, unlike `friend_groups`, which has real
  owner-only privileges — kicking via `is_group_owner()`, invite-code generation — that other
  current members plausibly still want). This asymmetry is why the migration treats the two
  differently (see "Judgment calls" below).
- **Producer Tag audio's real Storage path:** read `producerTagApi.ts`'s `uploadTag()` in full.
  Confirmed the bucket (`"producer-tags"`) and the exact path convention (`${tagId}/clip.webm`,
  stored verbatim in `producer_tags.audio_url`) — grepped every `.storage.from(` call site in
  `snufflestudy/src` and found only this one upload site and one download site, no other bucket
  anywhere in the codebase.
- **`wxt.config.ts`'s actual current permissions**, read directly: `manifest.permissions` is
  `["storage", "alarms", "notifications", "idle", "scripting", "declarativeNetRequest",
  "sidePanel"]`; `optional_host_permissions` is `["*://*/*"]`. Matches the plan's own recollection
  exactly — no permission has been added since the last check the plan itself references.
- **Settings/sign-out entry point:** the dispatch's guess ("likely `SettingsTab.tsx`") doesn't hold
  — read `SettingsTab.tsx` in full; it only composes `TempPasscodePanel`/`UnlockRequestPanel`, no
  sign-out button anywhere in it. Grepped `sign out`/`signOut` across every `.tsx` file — the sign-
  out button lives in `snufflestudy/src/options/pages/AccountPage.tsx` (the options surface, not
  the side-panel Settings tab). Both the privacy policy page and the account-deletion UI were built
  into the options surface's page set instead, next to the real sign-out button, matching the
  plan's actual intent ("alongside the existing sign-out button") more literally than the
  dispatch's own file-name guess.
- **Edge Function names, confirmed current:** `ls supabase/functions/` — `approve-temp-passcode`,
  `generate-coaching-message`, `generate-livekit-token`, `redeem-temp-passcode`,
  `send-temp-passcode-request`. `generate-coaching-message` and `send-temp-passcode-request` (the
  two the plan names for the privacy policy) both exist exactly as named.
- **What actually gets sent to Anthropic/Resend** (read both Edge Functions in full, not assumed):
  `generate-coaching-message` sends the user's **goal text** and the **distracting hostname** in
  the Claude prompt body (`userPrompt = Goal: "${goal}"\nThey just got distracted on: ${hostname}...`).
  `send-temp-passcode-request` sends the **friend's email** and the **requested hostname** to
  Resend. Both are named specifically in the privacy policy rather than left generic.
- **On-device storage, confirmed which is actually used:** grepped every `chrome.storage.local`
  call site (settings, active session snapshot, hard-block passcode credential hash, four separate
  per-feature poll-cursor timestamps in `friendPollState.ts`) and every `openDB(...)` call site —
  **both** `chrome.storage.local` and IndexedDB are genuinely used (two separate local databases:
  `"snufflestudy"` for session history/events, `"snufflestudy-tasks"` for tasks), not just one as
  the dispatch's phrasing ("confirm which is actually used") hinted might be the case.

## What I built

### 1. Privacy policy

**`snufflestudy/src/options/pages/PrivacyPolicyPage.tsx`** (new) — a static page bundled into the
extension's own options surface, wired into `OptionsApp.tsx`'s nav as a new "Privacy" view
(`snufflestudy/src/options/OptionsApp.tsx`: new `OptionsView` member, nav button, render branch).
Chosen over a hosted static page because this sandbox has no way to actually host or verify an
external URL — bundling it into the extension is the only format this session can build *and*
verify end-to-end (via the build output, see Verification below). Names every real destination
confirmed above: on-device storage (`chrome.storage.local` + both IndexedDB databases, itemized),
Supabase (Auth/Postgres — itemizing what's actually stored, explicitly noting session-status sync
never includes site names or goal text and only happens if `friendSyncEnabled` is on/Storage/
Realtime), Anthropic (explicitly stating the goal text + hostname are sent per-request, not stored
beyond the rate-limit timestamp), Resend (friend's email + requested hostname), and LiveKit
(explains the token-scoping model and that audio/video never transits Supabase). Also links the
"Delete account" action as the actual mechanism for removing everything it describes.

I did not attempt to look up live Chrome Web Store policy requirements against
`developer.chrome.com` — no web-search capability is available in this environment, and the
dispatch anticipated this ("you don't need to research live... if you don't have that capability").
Per the plan's own framing, this is real, specific, accurate content about *this app's* actual data
flows, not exact legal copy — **a human with product/legal context should review the wording
before any real Chrome Web Store submission**, particularly for jurisdiction-specific rights
language (GDPR/CCPA-style) and a genuine contact mechanism, neither of which this session has the
standing to originate.

### 2. Account/data deletion

**`supabase/migrations/20260815000032_v3.2_account_deletion.sql`** (new) — `public.
delete_account_data(p_user_id uuid) returns text[]`, `language plpgsql security definer set
search_path = public`, granted to `service_role` only (never `authenticated` — it takes an
explicit `p_user_id`, so it must never be directly client-callable). Deletes every row referencing
`p_user_id` across all fourteen verified tables, in FK-safe order, and returns the Producer Tag
`audio_url` paths it deleted from `producer_tags` (read via a `returning` clause in the same
statement as the delete) so the caller can remove the actual Storage objects. Full per-table
ordering and reasoning is documented in the migration's own header comment and inline; summary:

1. `producer_tag_sends` (sender/recipient/tag-owner = caller), then `producer_tags` (capturing
   `audio_url`s first).
2. `nudges`, `daily_digests`, `coaching_message_requests`, `session_status_events` — plain
   single/dual-column deletes.
3. `unlock_requests` — delete the caller's own requests; null out `resolved_by` (nullable) on
   requests the caller resolved for someone *else*, preserving that person's request history
   rather than deleting their row — the same "null a secondary reference, don't delete someone
   else's row" precedent `20260815000028`'s unredeem trigger already established for
   `invite_codes.used_by`.
4. `temp_passcode_requests` — both `requester_user_id` and `friend_user_id` are `NOT NULL`, so
   unlike `unlock_requests` there's no nullable secondary reference to preserve; a request where
   the caller was the assigned friend (not the requester) is deleted too. Documented as an
   accepted, unavoidable consequence of the `NOT NULL` FK, not an oversight.
5. `study_room_participants` (caller's own rows in rooms they don't own), then a full cascade for
   rooms the caller *does* own: null `producer_tag_sends.recipient_room_id` for sends into that
   room (preserves the send's own history), delete every `study_room_participants` row for that
   room (everyone's), delete the `study_rooms` row itself.
6. `friend_groups` owned by the caller: **reassign** `owner_user_id` to the longest-standing
   remaining member (`order by joined_at asc limit 1`) if other members exist; otherwise leave it
   pointing at the caller for now.
7. `group_memberships` — delete the caller's own rows in every group (fires the pre-existing
   `group_memberships_unredeem_invite_code` trigger, which un-redeems — nulls `used_by`, doesn't
   delete the row — any invite code the caller used).
8. `invite_codes` — delete codes for groups about to be deleted outright (FK-required, before
   `friend_groups` loses those rows); null `used_by` for the caller on any remaining group
   (redundant with step 7's trigger in the common case, kept as a defensive no-op); delete codes
   the caller `created_by`.
9. `friend_groups` — now safe to delete the ones still owned by the caller (step 6 already
   reassigned every group that had another member; a still-owned-by-caller row here means it truly
   has zero members left).
10. `friendship_settings` (both directions).

**`supabase/functions/delete-account/index.ts`** (new) — Edge Function, same CORS/JWT-verification
template as `generate-livekit-token`/`generate-coaching-message`. Takes **no request body at all**
(deliberately — there is no `userId` field to misuse; the only identity this function ever acts on
is `callerId`, resolved exclusively from `anonClient.auth.getUser(jwt)` against the caller's own
bearer token). Orchestrates, in order: (1) `adminClient.rpc("delete_account_data", { p_user_id:
callerId })` — all app-schema row deletion; (2) `adminClient.storage.from("producer-tags").
remove(paths)` for whatever `audio_url`s step 1 returned — best-effort, logged-not-fatal, since the
app-schema data (this function's main DoD guarantee) is already gone by this point regardless; (3)
`adminClient.auth.admin.deleteUser(callerId)` — the actual `auth.users` row removal, via Supabase's
own supported Admin API rather than raw SQL (raw SQL against the `auth` schema is explicitly
unsupported/risks skipping `auth.identities`/`auth.sessions`/`auth.refresh_tokens`/MFA cleanup that
the Admin API handles correctly).

**`snufflestudy/src/infrastructure/backend/accountApi.ts`** (new) — `deleteAccount()`: invokes the
Edge Function via `supabase.functions.invoke("delete-account")` (no body), then best-effort clears
the local Supabase session via `supabase.auth.signOut()` on success. Throws on failure (network
error, non-2xx, or a logical `{ error }` body) — matches `tempPasscodeApi.ts`'s `approveRequest()`
convention for a single-shot action with no graceful-degradation fallback.

**Message plumbing:** added `AUTH_DELETE_ACCOUNT` (no payload) to `snufflestudy/src/shared/
messages.ts`, and a `case "AUTH_DELETE_ACCOUNT"` in `snufflestudy/src/background/messageRouter.ts`
that calls `accountApi.deleteAccount()` and returns `{ ok: true }` (throws surface as `{ ok: false,
error }` via the existing outer `handleMessage` try/catch, same convention as `GROUP_CREATE`).

**UI:** `snufflestudy/src/options/pages/AccountPage.tsx` — new "Delete account" section right next
to the existing "Sign out" section (signed-in view only), with a `window.confirm(...)` gate before
sending anything (same established convention as this same file's `handleLeaveGroup`, strengthened
wording since account deletion is a strictly bigger, unrecoverable action than leaving one group).
On success, resets the same account-scoped local state `handleSignOut` already resets (`session`,
`group`, `inviteCode`, `members`), returning the page to the signed-out `SignInForm`.

**Tests added** (this codebase's established convention — every `*Api.ts` file and every UI action
elsewhere on this page already has coverage, so I matched it rather than leaving new code
untested): `snufflestudy/src/infrastructure/backend/accountApi.test.ts` (invoke call shape, both
error paths, and that a failed local sign-out doesn't turn a successful deletion into a thrown
error) and three new cases in `snufflestudy/src/options/pages/AccountPage.test.tsx`'s existing
"signed in" describe block (confirms, cancels, and server-error paths, mirroring the file's own
"leaving a group" test block exactly).

### 3. Permission audit

Re-checked every permission in `wxt.config.ts` against a real, currently-shipped feature:

| Permission | Feature | Confirmed via |
|---|---|---|
| `storage` | `chrome.storage.local` (settings, active session, hard-block credential, poll cursors) | grep across `infrastructure/storage/*.ts`, `friendPollState.ts` |
| `alarms` | Session timers, friend/nudge/unlock/digest/temp-passcode polling, temp-unlock relock | `alarmHandlers.ts`, `alarmsApi.ts`, `friendPollState.ts` |
| `notifications` | Nudge/digest/unlock toasts | `notificationsApi.ts`, `alarmHandlers.ts`, `messageRouter.ts` |
| `idle` | Activity tracking during focus sessions | `idleHandlers.ts`, `activityTrackingHandlers.ts`, `idleApi.ts` |
| `scripting` | Overlay content-script registration (detailed tracking tier) | `contentScriptRegistration.ts`, `OptionsApp.tsx` |
| `declarativeNetRequest` | Hard-block redirects | `declarativeNetRequestApi.ts`, `tabHandlers.ts` |
| `sidePanel` | The side panel itself | manifest `side_panel.default_path`, `PopupApp.tsx` |
| `optional_host_permissions: *://*/*` | Detailed site tracking tier + per-hostname hard-block enforcement, both runtime-requested via `chrome.permissions.request` (never silently granted at install) | `permissionsApi.ts` (`requestDetailedTrackingPermission`, `requestHardBlockHostPermission`) |

**Finding: already minimal, nothing to add or remove.** Every permission maps to a real, named,
currently-shipped feature; `optional_host_permissions` is still runtime-requested rather than a
static grant, matching the plan's own note that this was already true as of the last v2 check. One
adjacent observation, not a gap: `chrome.tabs` APIs (`tabs.query`, `tabs.onUpdated`, `tabs.remove`)
are used (`tabsApi.ts`, `tabHandlers.ts`, `messageRouter.ts`) without the extension declaring the
`tabs` permission — this is intentional, not missing: those calls work fine without it, and
`tab.url` visibility (the one field that needs *some* permission) is already covered by the runtime-
granted host permissions above rather than the broader, more alarming-to-users `tabs` grant. Built
the extension (`npm run build`) and confirmed the emitted `manifest.json`'s `permissions`/
`optional_host_permissions` are byte-for-byte what's expected, with nothing added by this task's
own changes.

## Judgment calls

1. **Reassign vs. cascade-delete for `friend_groups` vs. `study_rooms` ownership** — the two are
   handled differently, deliberately (see "What I built" and the migration's own header comment for
   the full reasoning): `friend_groups` reassigns to the longest-standing remaining member because
   it's this schema's ongoing social structure with real owner-only privileges other current
   members plausibly still rely on; `study_rooms` cascade-deletes outright (dropping other
   participants' join/leave history for that one room, nulling any Producer Tag send that pointed
   into it) because it has no client-facing update/delete policy at all — no existing "close a
   room" concept, no ownership-transfer precedent, and reassigning ownership of a defunct video-call
   session to a former participant has no product meaning. This is the plan's own explicitly
   flagged "real decision, not just row deletion" — made and documented, not left implicit.
2. **Built the callable entry point as an Edge Function, with a `service_role`-only SQL helper
   behind it, rather than a plain client-callable RPC** (the plan explicitly offers either). Two of
   the operation's three components need privileges/APIs a Postgres function can't reach on its
   own: Storage object removal needs the Storage HTTP API (deleting `storage.objects` rows via raw
   SQL only removes metadata, not the backing bytes), and `auth.users` removal needs the Auth Admin
   API (Supabase's own supported mechanism, which also correctly tears down
   identities/sessions/refresh-tokens/MFA factors — none of which this codebase's migrations own or
   could safely hand-delete via raw SQL against the `auth` schema). The self-service guarantee
   ("callable only by the authenticated user themselves") is satisfied structurally, not by a
   runtime check: the Edge Function's request body has no user-id field to misuse at all.
3. **Corrected the plan's own table list** (fourteen tables, not twelve — see Pre-flight section)
   rather than silently applying the shorter list. Flagged explicitly per this session's working
   convention (matching Tasks 5/6's reports' own precedent of flagging, not silently applying,
   corrections to the plan's stated facts).
4. **Privacy policy bundled into the extension's options surface**, not hosted externally — this
   sandbox has no way to host or verify an external URL; a bundled page is the only format
   verifiable end-to-end here (via the real build output). Documented in the page's own header
   comment as a deliberate choice, not an oversight, should a real submission later want a
   separately-hosted page instead (both can coexist — the options page's content can be copied
   verbatim to an external host).
5. **Added test coverage for the new `accountApi.ts`/`AccountPage.tsx` code**, though the task
   brief didn't explicitly list new tests as a deliverable. Matched this codebase's own extremely
   consistent existing convention (every `*Api.ts` file and every destructive UI action on this
   exact page already has coverage) rather than leaving new, first-party code as the one
   untested exception.

## What I verified — live vs. static

**Could not verify live (environment limitation, not a task blocker, consistent with Tasks 5/6):**
this sandbox's write-safety classifier blocks mutating connections to the live Supabase database.
I did not apply this migration (or Tasks 5/6's still-pending ones) to any real database, and did
not deploy or invoke the `delete-account` Edge Function against a live project. Per this task's own
Definition of Done, the two live-only checks —
- "a signed-in test account can delete their account and confirm (via a service-role query) that no
  row referencing their `auth.uid()` remains in any table listed above" (this task's own extended,
  fourteen-table list, not the plan's original twelve), and
- confirming `auth.admin.deleteUser` and the Storage `.remove()` call actually succeed against a
  real project (in particular, whether `storage.objects` has any FK/trigger dependency on
  `auth.users` that this codebase doesn't control, which the Edge Function's step-2-before-step-3
  ordering is designed to avoid but can't be proven without a live run)

are **both outstanding** and need a human (or a session with DB-write and Edge-Function-deploy
permission) to run before this branch merges or ships, ideally as part of Task 9's manual QA pass.

**Statically verified (this session):**
- Read `delete_account_data`'s full SQL against the confirmed-live-matching schema (table/column
  names verified via the same `create table` grep the migration's own header documents) and traced
  every statement's FK-safety by hand, in execution order, confirming no statement could fail due
  to a dangling reference left by an earlier statement (the full per-table ordering is listed in
  "What I built" above).
- `npx vitest run` (full suite, from `snufflestudy/`) → **85 files, 819 tests, all passed** (812
  baseline from Tasks 5-7, plus 7 new: 4 in `accountApi.test.ts`, 3 new cases added to the existing
  `AccountPage.test.tsx` describe block).
- `npm run compile` (`tsc --noEmit`) → clean, no type errors.
- `npm run build` (`wxt build`) → succeeds; inspected the emitted `.output/chrome-mv3/manifest.json`
  directly and confirmed `permissions`/`optional_host_permissions` are unchanged and match the
  permission-audit table above exactly.
- Manually re-read the full `delete-account/index.ts` end to end against the exact CORS/JWT/
  admin-client template `generate-livekit-token`/`generate-coaching-message` already use — same
  shape, no novel pattern introduced.
- As with Tasks 5/6, `supabase/functions/` has no type-checking mechanism in this repo at all (no
  `deno.json`, no CI, no Deno/Supabase CLI installed in this sandbox) — this predates this task and
  isn't something it introduces or fixes; the new Edge Function was checked by careful manual
  re-read against the existing three functions' proven-working shape, not a type-checker.

## What's still open

- **Live DB + Edge Function verification is the one real gap**, per above — this needs a human (or
  a permitted session) to: apply this migration (and Tasks 5/6's two still-pending ones) to a real
  project, deploy `delete-account`, and run a genuine test-account deletion followed by a
  service-role query confirming zero rows remain across all fourteen tables plus zero Storage
  objects plus the `auth.users` row itself gone. This should happen before this branch merges,
  ideally as part of Task 9's own QA pass.
- **Privacy policy wording needs product/legal review** before any real Chrome Web Store
  submission — the content is accurate and specific to this app's real data flows (verified against
  actual code throughout, not assumed), but is not vetted legal copy, per this task's own framing
  that policy wording is a judgment call this plan deliberately didn't prescribe.
- **Permission audit found nothing to change** — documented as a real, checked finding ("already
  minimal"), not a skipped step.
- Nothing else within Task 8's stated scope is incomplete. Tasks 1-7 are untouched by this work.
