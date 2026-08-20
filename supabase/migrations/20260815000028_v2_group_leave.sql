-- v2 follow-up (Item 2 of two user-approved post-final-review items). Closes finding I4 from the
-- final whole-branch review: there was no way to leave a friend group anywhere in the schema, API,
-- or UI - group_memberships had SELECT (20260815000003) and INSERT (20260815000005) policies but
-- no DELETE policy at all, and (confirmed by reading every migration's GRANT statements before
-- writing this one, not assumed) no DELETE grant restriction has ever been added either -
-- 20260815000003's blanket `grant select, insert, update, delete on ... group_memberships ... to
-- authenticated, service_role` already covers DELETE at the SQL-privilege layer. So the entire gap
-- was RLS-only: the grant was already open, but with RLS enabled and zero permissive DELETE
-- policy, every DELETE attempt against this table has always silently affected zero rows.
--
-- === Part 1: the DELETE policy itself ===
--
-- `user_id = auth.uid()` lets a member remove their own row (leave); `is_group_owner(...)` (the
-- existing helper from 20260815000005, reused rather than reinvented) lets the group's owner
-- remove someone else's row (kick). Both conditions are checked the same way group_memberships'
-- own INSERT policy already checks group ownership, so this introduces no new RLS-recursion risk.
--
-- Judgment call: should is_group_owner also gate the owner's OWN leave (i.e. require an owner to
-- transfer ownership before leaving)? There is no ownership-transfer mechanism anywhere in this
-- schema, so requiring one would make it impossible for an owner to ever leave their own group.
-- Simplest defensible choice, taken here: the owner leaves via the same `user_id = auth.uid()`
-- branch as anyone else - no special-casing. Consequence: friend_groups.owner_user_id becomes an
-- orphaned reference (a user_id with no matching group_memberships row for that group) once the
-- owner leaves. Verified harmless before writing this migration by grepping every migration for
-- `owner_user_id` usage: every read of friend_groups.owner_user_id (is_group_owner() itself; the
-- old "users can create groups they own"/group_memberships INSERT-as-owner policies) only ever
-- checks the STORED VALUE on the friend_groups row - none of them re-verify that the owner is
-- still a current group_memberships member. study_rooms/producer_tag_sends' many owner_user_id
-- checks are a same-shaped but entirely separate concept (study_rooms.owner_user_id, Task 13/14's
-- room ownership - a different table, never joined against friend_groups). The one concrete,
-- intentional side effect: invite_codes' INSERT policy (20260815000002:51-59) requires the
-- creator to be a CURRENT group_memberships row, so a departed owner can no longer generate new
-- invite codes for a group they've left - but since is_group_owner() is unaffected by leaving,
-- they can always re-add themselves via this same policy's owner branch and regain that ability,
-- so this is a minor friction, not a lockout.
--
-- Fix-round addendum (Important #2, adjudicated - not just a consequence for invite-code creation,
-- stated plainly here): the same "is_group_owner() is unaffected by leaving" fact above means the
-- re-join gap THIS PART 2 exists to close (see below) does not apply to the group's owner. Every
-- non-owner member is fully gated on rejoin by Part 2's has_redeemed_invite_code() check plus the
-- unredeem trigger below - but group_memberships' INSERT policy's owner branch
-- (20260815000005:60-68) lets an owner re-insert their own membership row with ZERO invite code,
-- any time, forever, because is_group_owner() only ever reads the immutable
-- friend_groups.owner_user_id column and this schema has no ownership-transfer mechanism that
-- could ever change it. This is intentional, not an oversight: it exposes no other user's data or
-- access - only the owner's own pre-existing right to walk back into the group they created.
-- Building real ownership-transfer or owner-specific re-join gating is a materially larger design
-- change (there is no ownership-transfer mechanism anywhere in this schema to hook such gating
-- into) that is out of scope for this fix round. Accepted asymmetry, deliberately, not a gap left
-- open by mistake.
create policy "member can leave or owner can remove a member"
  on group_memberships for delete
  using (
    user_id = auth.uid()
    or is_group_owner(group_memberships.group_id, auth.uid())
  );

-- Fix-round addendum (Minor #2): why a departed owner can't retain kick power via this policy's
-- own-branch, stated explicitly rather than left incidentally true. is_group_owner() reads only
-- the immutable friend_groups.owner_user_id column (see the addendum above), so the `or
-- is_group_owner(...)` branch above stays true for a departed owner forever - by itself that
-- would let them keep DELETE-ing OTHER members' rows (kicking) after leaving. What actually blocks
-- that: Postgres implicitly ANDs a table's SELECT policy onto every other operation's USING
-- clause, including DELETE (documented Postgres RLS behavior, not something this schema opts into
-- - see "Row Security Policies" in the Postgres docs: a DELETE's row must satisfy the target
-- table's SELECT policy in addition to the DELETE policy's own USING clause). group_memberships'
-- SELECT policy is is_group_member(group_id, auth.uid()) (20260815000003) - a departed owner is no
-- longer a group_memberships row for that group, so is_group_member() is false for them, so the
-- implicit SELECT-AND fails and the DELETE is blocked regardless of what the DELETE policy above
-- says. This is a different mechanism than the WITH CHECK-style reasoning that guards INSERT/
-- UPDATE (this policy has no WITH CHECK at all - DELETE doesn't use one) - it's the implicit
-- SELECT-policy-AND, specifically.

-- === Part 2: closing the re-join-without-a-fresh-invite gap ===
--
-- has_redeemed_invite_code(group_id, user_id) (20260815000005) checks whether an invite_codes row
-- exists with used_by = user_id and group_id = group_id - the SOLE non-owner gate on
-- group_memberships' INSERT policy. That row is never cleared today, so without this trigger, a
-- departed member (self-left or kicked) could instantly re-satisfy the INSERT policy and rejoin
-- with no fresh invite - the exact "one route closed, structurally identical sibling left open"
-- pattern this project's final review has flagged repeatedly (see 20260815000025's header comment
-- for the most recent instance): closing the read/write path to *join* a group without closing the
-- symmetric path to silently *stay* joined after being removed would leave the whole feature
-- pointless.
--
-- Fix: an AFTER DELETE trigger that nulls out used_by (not group_id/code/created_by/expires_at) on
-- every invite_codes row matching (group_id = old.group_id and used_by = old.user_id) - "un-
-- redeeming" the code rather than deleting the row. Deliberate choice, not the only option:
--   - Nulling used_by makes the code available again to whoever holds the code string - the same
--     bearer-secret model the final review's Critical fix already established for this table (a
--     code is authorization by possession, not by identity). Whoever the departed member shared
--     that code with (most likely: nobody else, since they used it themselves) could redeem it
--     again; more importantly, the code's ORIGINAL owner-flow (the group owner reissuing it, or
--     it simply expiring per expires_at) still governs whether it's usable at all.
--   - Deleting the invite_codes row instead was rejected: it would destroy the row's audit trail
--     (created_by, expires_at, and the fact that this code was ever issued) for no benefit - the
--     row's continued existence costs nothing and preserves history a group owner might want
--     (e.g. "who created this code, when does/did it expire").
--   - Leaving used_by permanently set (doing nothing) was rejected as exactly the bug being fixed:
--     a permanent redeemed-marker that silently grandfathers re-entry forever, with no way for a
--     kicked member to ever be actually removed from the group's trust boundary.
--
-- SECURITY DEFINER (matching every cross-table helper in this schema since 20260815000003): the
-- UPDATE grant on invite_codes was fully REVOKED from `authenticated` by 20260815000025, so a
-- plain (non-definer) trigger firing under a real member's own DELETE would fail outright with
-- "permission denied for table invite_codes" the moment a member actually left. Running as the
-- function's owner (postgres, which owns invite_codes and was never subjected to FORCE ROW LEVEL
-- SECURITY on it) is what makes this trigger able to do its job regardless of who performed the
-- triggering DELETE.
--
-- No `where code = ...` narrowing to a single row: a user who is already a member and later
-- redeems a SECOND code for the same group (redeem_invite_code's `on conflict do nothing` case)
-- can have more than one invite_codes row with used_by = them for the same group_id. On leaving,
-- every one of those becomes available again, not just one - symmetric with "this user is no
-- longer relying on any of the access grants those redemptions represent."
create or replace function public.unredeem_invite_code_on_membership_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update invite_codes
     set used_by = null
   where group_id = old.group_id
     and used_by = old.user_id;

  return old;
end;
$$;

create trigger group_memberships_unredeem_invite_code
  after delete on group_memberships
  for each row
  execute function public.unredeem_invite_code_on_membership_delete();
