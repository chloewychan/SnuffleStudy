# Task 1 report — Nudge Vault schema + API

**Note on provenance:** the subagent originally dispatched for this task was terminated mid-work by an account-level session/usage limit (not a task failure) after it had already written all production code but before it verified/committed. The orchestrating session (this report's author) picked up from that point: inspected every uncommitted diff line-by-line against the plan, ran static verification, and committed. No production code was rewritten during that handoff — only cleanup (removing two scratch verification scripts) and verification/commit.

## What was built

- `supabase/migrations/20260815000046_v4.1_nudge_vault.sql` (new) — `nudge_vault_texts` table + RLS + grants, `producer_tags.deleted_at`, `nudges.custom_body` + `nudges_exactly_one_body` check constraint.
- `snufflestudy/src/infrastructure/backend/nudgeVaultApi.ts` (new) — `createVaultText`/`listMyVaultTexts`/`deleteVaultText`.
- `snufflestudy/src/infrastructure/backend/producerTagApi.ts` — added `listMine()`, `softDelete()`.
- `snufflestudy/src/infrastructure/backend/nudgeApi.ts` — `FriendNudge.messageId` now nullable, `+customBody`; new `NudgeSource` union; `sendNudge()` takes a `NudgeSource` instead of a bare `messageId`.
- `snufflestudy/src/shared/messages.ts` — `NUDGE_SEND` payload becomes a union (`messageId` | `vaultTextId`); new `NUDGE_VAULT_TEXT_CREATE`/`LIST`/`DELETE`, `PRODUCER_TAG_LIST_MINE`/`DELETE`.
- `snufflestudy/src/background/messageRouter.ts` — new cases for all of the above; `NUDGE_SEND` narrows the payload into a `NudgeSource` at the router boundary.
- `snufflestudy/src/sidepanel/components/friendGroupPanel/IncomingNudgeCard.tsx` — display text now `customBody ?? (messageId ? catalog text : null) ?? "sent you a nudge."`.
- Ripple fixes required by `messageId` becoming nullable / `customBody` being added to `FriendNudge`, found by `tsc`/tests, not separately called out in the plan: `background/alarmHandlers.ts`'s own incoming-nudge notification fallback (mirrors `IncomingNudgeCard.tsx`'s identical logic), plus test fixture updates in `alarmHandlers.test.ts`, `messageRouterAccountability.test.ts`, `FriendGroupPanel.test.tsx`, `nudgeApi.test.ts`.

## Deviation from the plan

**Migration filename corrected.** The plan names this file `20260815000045_v4.1_nudge_vault.sql`; that number was already taken by `20260815000045_v3.4_qa_friend_requests_immutable_trigger_account_deletion_fix.sql` (a v3.4 QA migration that landed after the plan was written). Verified by listing `supabase/migrations/` directly — `20260815000045` is the current highest number, so this migration is `20260815000046`, the next free slot. No other content deviates from the plan's given SQL.

## What was verified

- `npm run compile` (`tsc --noEmit`): clean.
- `npx vitest run` (full suite, after Task 6 also landed): 909/910 pass. The one failure (`StudyRoomPanel.test.tsx`) is confirmed pre-existing/flaky — passes in isolation, and that file is untouched by this task.
- Read the current `producer_tags` "owner can manage their own producer tags" policy (`20260815000002`) and the immutable-columns trigger (`20260815000021`) directly to confirm the plan's claim that `deleted_at` is unrestricted by both — confirmed accurate before writing the migration.
- Read the current `nudges`/`producer_tags` table definitions and every existing consumer of `FriendNudge`/`sendNudge()` before editing, per the workflow's verify-before-trust step.

## What's still open

- **Update:** the migration **has now been applied to the live Supabase project.** It turned out the interrupted subagent had already run it successfully (unlike the v3.2 precedent's blocked attempt) before being cut off by the session limit — `scripts/apply-migrations.mjs` reported it as already tracked in `_migrations`. Confirmed for real via a read-only live query (not just trusting the tracking table): `nudge_vault_texts` (id/user_id/body/created_at, all NOT NULL as specified), `producer_tags.deleted_at` (nullable timestamptz), `nudges.message_id`/`nudges.custom_body` (both nullable), and the `nudges_exactly_one_body` check constraint are all present on the live schema. The user was asked explicitly before this was confirmed as intentional/wanted, and approved.
- Still open: no live functional (not just schema-shape) round-trip has been run yet — e.g. `NUDGE_VAULT_TEXT_CREATE` → `NUDGE_VAULT_TEXT_LIST`, a vault send's `custom_body` round-trip, the negative cross-user-vault-id case, or the producer-tag soft-delete round-trip. Worth doing as part of Task 11's manual QA pass (item 4 in the plan's Task 11 already covers the vault send/delete round-trip explicitly) rather than repeating it standalone here.
- No new automated tests exercise the vault-specific branches of `sendNudge()`/`nudgeVaultApi.ts` beyond type-level/unit coverage of the catalog path (existing tests were updated for the new call signature, not extended with new vault-path unit tests, since the interesting behavior — RLS ownership enforcement — can only be meaningfully tested live, per this codebase's own `verify-*.mjs` convention). A `scripts/verify-nudge-vault.mjs` in that same style would be a reasonable follow-up, mirroring `verify-producer-tags.mjs`/`verify-nudges.mjs`.
