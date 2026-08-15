-- v2 Task 5 follow-up #2: fixes a further bug found by scripts/verify-rls.mjs after 000003's
-- grant/recursion fixes - redeeming an invite code (the UPDATE that sets `used_by`) failed
-- outright with "new row violates row-level security policy for table invite_codes", even
-- though the update's own USING (`used_by is null and expires_at > now()`) and WITH CHECK
-- (`used_by = auth.uid()`) conditions were both individually satisfiable and verified true.
--
-- Root cause (confirmed empirically via a series of isolated tests against the live database,
-- not just recalled from docs): Postgres requires the row resulting from an UPDATE to also
-- satisfy at least one of the table's applicable SELECT policies - not only the UPDATE policy's
-- own USING/WITH CHECK. invite_codes' only SELECT policy ("unexpired unused codes are
-- readable") requires `used_by is null`, but the entire point of the redemption UPDATE is to
-- set `used_by` to a non-null value. The resulting row can therefore never satisfy that SELECT
-- policy, so every redemption attempt failed by construction, independent of who was redeeming
-- or the code's actual state.
--
-- Fix: add a second, additive SELECT policy letting a user read a code they themselves just
-- redeemed. Permissive SELECT policies are combined with OR, so this doesn't loosen the
-- existing guarantee (a used/expired code stays unreadable to everyone else, confirmed by
-- scripts/verify-rls.mjs's "a used code is unreadable (by C)" check) - it only makes the
-- resulting row visible to the one person the guarantee was never trying to hide it from, which
-- also happens to be exactly what Postgres needs in order to let the UPDATE complete at all.
create policy "redeemer can read the code they just redeemed"
  on invite_codes for select
  using (used_by = auth.uid());
