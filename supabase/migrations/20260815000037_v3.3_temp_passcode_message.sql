-- v3.3 Task 11: adds an optional message field to temp_passcode_requests, so the requester can
-- explain why they need a temporary pass and the approving friend has something to judge beyond a
-- bare hostname.
--
-- Sequenced after Task 10's migration (20260815000036_v3.3_temp_passcode_no_code.sql) per
-- Decision 2 (docs/implementation_plans/V3.3_Implementation_Plan.md) - that migration drops four
-- columns from this same table, so landing this add in its own clean follow-up migration avoids a
-- single migration that both adds and removes columns on the same table, or a rebase headache if
-- the two were built out of sequence.
--
-- Nullable, no CHECK constraint - the plan's own Deliverables line is explicit that any length
-- limit belongs on the client input (see LockedPage.tsx's maxLength), not a DB constraint. No RLS
-- change is needed: the existing "users can create their own genuinely-pending temp passcode
-- requests" INSERT policy (rewritten by 20260815000036) validates specific columns' values, not an
-- exhaustive column list, so a new nullable column requires no policy update to remain insertable.
alter table temp_passcode_requests
  add column message text;

-- Gap found by actually exercising this end-to-end against the live DB as a real signed-in user
-- (per this task's own instruction to verify directly, not just by inspection) - not by reading
-- the plan's literal SQL block, which is a bare `add column` with no grant. 20260815000016 revoked
-- table-level SELECT from `authenticated` entirely and replaced it with a column-level SELECT
-- grant naming an explicit column list. A table-level grant (e.g. this table's INSERT, still
-- table-level since migration 20260815000003) automatically covers a newly added column, but a
-- COLUMN-level grant does not - `message` came out of the `add column` above with INSERT/
-- REFERENCES (inherited from the table-level grants) but no SELECT at all, since it was never
-- named in 20260815000016's list. Left unfixed, tempPasscodeApi.ts's every read of
-- TEMP_PASSCODE_COLUMNS (which now includes `message`) would fail outright for `authenticated`
-- with "permission denied for table temp_passcode_requests" - confirmed by reproducing exactly
-- that failure live before adding this grant.
grant select (message) on temp_passcode_requests to authenticated;
