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

- **The migration has not been applied to the live Supabase project.** This repo's `.env` points at a real, live Supabase project (confirmed by a prior task's report — v3.2's task-5 report — hitting the same situation: an environment safety block on mutating a live database via a direct Postgres connection, requiring explicit human permission). Applying DDL to shared live infrastructure is exactly the kind of hard-to-reverse, shared-system action this session's own operating instructions say to confirm with the user first, so it was not attempted. **This needs either the user's explicit go-ahead to apply it now, or the user applying it themselves** (e.g. via the Supabase SQL editor, `supabase db push`, or a permitted `scripts/apply-migrations.mjs` run) before any of the following can be genuinely live-verified:
  - A vault text created via `NUDGE_VAULT_TEXT_CREATE` appearing in `NUDGE_VAULT_TEXT_LIST`.
  - Sending a vault text inserting a `custom_body`-set row, correctly rendered on the recipient side.
  - The negative case: `NUDGE_SEND` with a `vaultTextId` belonging to a different user's vault failing with "This nudge no longer exists in your vault."
  - A producer tag's soft-delete round-trip (`PRODUCER_TAG_LIST_MINE` → `PRODUCER_TAG_DELETE` → list no longer shows it, but a friend's earlier-received send still plays).
  - The SQL itself was re-read end-to-end against the live schema's actual column names (confirmed via a scratch, read-only `information_schema` query against the live project before it was interrupted) — no mismatch found, but this is not the same as an applied-and-exercised migration.
- No new automated tests exercise the vault-specific branches of `sendNudge()`/`nudgeVaultApi.ts` beyond type-level/unit coverage of the catalog path (existing tests were updated for the new call signature, not extended with new vault-path unit tests, since the interesting behavior — RLS ownership enforcement — can only be meaningfully tested live, per this codebase's own `verify-*.mjs` convention). A `scripts/verify-nudge-vault.mjs` in that same style would be a reasonable follow-up once the migration is live, mirroring `verify-producer-tags.mjs`/`verify-nudges.mjs`.
