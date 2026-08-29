-- v4.1 Task 1: Nudge Vault schema + API.
--
-- Filename correction vs. the implementation plan: the plan's own Interfaces section names this
-- file "20260815000045_v4.1_nudge_vault.sql", but that number was already taken by
-- 20260815000045_v3.4_qa_friend_requests_immutable_trigger_account_deletion_fix.sql (a v3.4 QA
-- migration that landed after this plan was written). Verified directly by listing
-- supabase/migrations/ before writing this file - 20260815000045 is the current highest number,
-- so this migration is 20260815000046, the next free sequential slot. No other content changes
-- from the plan's SQL block.
--
-- Gives every user a personal, deletable library of audio and written nudges - the source both
-- for the new Nudge Vault box's own lists (Task 9) and for every "pick a nudge to send" dropdown
-- elsewhere (Friends box, Study Room footer - Tasks 7/9). Audio reuses producer_tags directly (see
-- Decision 2 in the plan) - it's already exactly "an audio clip I recorded," just missing a "list
-- mine" query and a safe delete; only the written half needs a new table.

-- === nudge_vault_texts: the written half of the Nudge Vault. Audio reuses producer_tags
-- directly (see below) - no parallel table needed there, just list/soft-delete it doesn't have yet.
create table nudge_vault_texts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id),
  body        text not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now()
);

alter table nudge_vault_texts enable row level security;

create policy "owner can manage their own vault texts"
  on nudge_vault_texts for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on nudge_vault_texts to authenticated;
grant select, insert, update, delete on nudge_vault_texts to service_role;

-- === producer_tags: soft-delete (Decision 2). The existing "owner can manage their own producer
-- tags" FOR ALL policy (20260815000002) already covers this UPDATE; the existing immutable-
-- columns trigger (20260815000021) only pins user_id/audio_url/duration_ms/created_at, so this
-- new column is unrestricted by it - no trigger/policy change needed, only the column itself.
-- Verified directly against both migration files before writing this: the policy is genuinely
-- `for all using (user_id = auth.uid()) with check (user_id = auth.uid())` with no column list,
-- and the trigger's guard clause names exactly those four columns and no others.
alter table producer_tags add column deleted_at timestamptz;

-- === nudges: a vault-authored written nudge is copied into custom_body at send time (Decision
-- 1) rather than referencing nudge_vault_texts live. message_id becomes nullable; exactly one of
-- the two is set per row.
alter table nudges alter column message_id drop not null;
alter table nudges add column custom_body text;
alter table nudges add constraint nudges_exactly_one_body check (
  (message_id is not null) <> (custom_body is not null)
);
