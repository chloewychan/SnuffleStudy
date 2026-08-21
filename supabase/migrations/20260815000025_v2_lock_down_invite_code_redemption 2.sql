-- v2 final whole-branch review, Critical finding C1: any authenticated stranger could join any
-- friend group.
--
-- Task 5's original invite_codes SELECT policy (20260815000002_v2_rls_policies.sql:47-49) had NO
-- auth.uid() predicate of any kind:
--
--   create policy "unexpired unused codes are readable"
--     on invite_codes for select
--     using (expires_at > now() and used_by is null);
--
-- Combined with the table-level `grant select, insert, update, delete on ... invite_codes ... to
-- authenticated` (20260815000003), that made every currently-outstanding invite code in the whole
-- project - code string AND group_id - enumerable by ANY authenticated account with zero
-- relationship to anyone, via a single unfiltered `supabase.from("invite_codes").select()`.
--
-- The UPDATE (redemption) policy (20260815000002:64-67) had no ownership/authorization predicate
-- either - only `used_by is null and expires_at > now()` in USING and `used_by = auth.uid()` in
-- WITH CHECK. It was written to make redemption single-use, never to establish WHO may redeem. So
-- the same stranger could then:
--
--   supabase.from("invite_codes").update({ used_by: self }).eq("code", <any enumerated code>)
--
-- which satisfies both clauses trivially. That flips has_redeemed_invite_code(group_id, self) to
-- true, and that predicate is the SOLE gate group_memberships' INSERT policy applies
-- (20260815000005:60-68) - so the stranger inserts themselves into group_memberships and is a
-- full member of a group they were never invited to. Downstream, membership is the floor for
-- essentially every other feature in v2: Task 10's group_memberships auto-create trigger
-- (20260815000012:67-95) immediately materializes friendship_settings rows in BOTH directions for
-- every existing member, and Task 5's `default true` on send_live_nudges/receive_live_nudges/
-- receive_daily_digest (20260815000001:47-49) means those rows arrive pre-granting the attacker
-- live session-activity visibility, daily digests, unlock-request visibility, and study-room
-- discovery/join for every existing member of that group. One REST call away from a cold account.
--
-- The premise both original policies rested on - stated in 20260815000002's own comment ("Read
-- access is intentionally not gated on group membership - the whole point of a code is letting a
-- non-member redeem it") and repeated in friendGroupApi.ts's joinGroup() comment - conflates two
-- different things. A non-member must be able to REDEEM a code they were GIVEN; that never
-- required the code to be LISTABLE by third parties. An invite code is a bearer secret: knowing
-- the string is the whole authorization, so any policy that lets a third party read the string
-- hands out the authorization itself.
--
-- Fix, three parts:
--   1. SELECT is restricted to `created_by = auth.uid() or used_by = auth.uid()` - you can see
--      codes you issued, and codes you personally redeemed. Never anyone else's outstanding code.
--      Both of Task 5's SELECT policies are dropped and replaced by this single one: the original
--      unauthenticated-readable policy is the vulnerability itself, and 20260815000004's
--      "redeemer can read the code they just redeemed" (added only so the redemption UPDATE's
--      resulting row could satisfy some SELECT policy) is subsumed by the `used_by = auth.uid()`
--      half here. Permissive SELECT policies OR together, so leaving the broad one in place
--      alongside a narrow one would accomplish exactly nothing.
--   2. Client UPDATE is REVOKED outright, not narrowed - the same remedy and rationale Task 12's
--      fix round 1 used for temp_passcode_requests (20260815000017:36). Redemption is the only
--      legitimate client UPDATE this table ever had, and it now happens inside the SECURITY
--      DEFINER function below instead. The redemption policy is dropped alongside the grant so a
--      future migration that re-grants UPDATE (e.g. by re-running 20260815000003's blanket grant
--      list) cannot silently re-open this exact hole.
--   3. redeem_invite_code(p_code) - a SECURITY DEFINER function that looks the code up BY EXACT
--      VALUE (knowing the string is the authorization; there is no enumeration surface because
--      there is no listing operation), validates unused + unexpired, marks it redeemed, and
--      inserts the group_memberships row, ALL IN ONE TRANSACTION.
--
-- Part 3 also closes two previously-deferred ledger items as a direct consequence:
--   - Task 5's non-atomic joinGroup() (friendGroupApi.ts's own comment: "if the membership insert
--     fails after this succeeds, the code is burned with no membership granted"). A single
--     function body is one transaction - a failure anywhere rolls back the redemption too, so a
--     code can never be burned without membership being granted.
--   - Task 8's WITH CHECK deferral, which was justified on the grounds that "the party gaining
--     access is already trusted with those columns". With client UPDATE fully revoked that
--     premise no longer exists at all: there is no client-reachable UPDATE path to this table.

-- === Part 1: SELECT restricted to codes you created or personally redeemed ===

drop policy "unexpired unused codes are readable" on invite_codes;
drop policy "redeemer can read the code they just redeemed" on invite_codes;

create policy "creators and redeemers can read their own invite codes"
  on invite_codes for select
  to authenticated
  using (created_by = auth.uid() or used_by = auth.uid());

-- === Part 2: no client-reachable UPDATE path at all ===

drop policy "unused unexpired codes can be redeemed once" on invite_codes;
revoke update on invite_codes from authenticated;

-- === Part 3: the one legitimate redemption path ===

-- Runs as the function owner (postgres, which owns invite_codes/group_memberships and was never
-- subjected to FORCE ROW LEVEL SECURITY on them), so the lookup deliberately bypasses the
-- narrowed SELECT policy above - an invitee legitimately cannot read the row before redeeming it,
-- which is exactly the point of Part 1. Authorization is not weakened by that bypass: the ONLY
-- way to reach the row is to already know its exact primary-key value, which is the bearer secret
-- itself. There is no wildcard/listing/prefix form of this call.
--
-- Mirrors the SECURITY DEFINER helper style used throughout this schema (is_group_member /
-- has_redeemed_invite_code - 20260815000003, 20260815000005; deny_temp_passcode_request -
-- 20260815000017), including the `set search_path = public` pin and the
-- revoke-from-public/grant-execute-to-authenticated pair below.
--
-- `for update` on the lookup row-locks the code for the duration of the transaction, so two
-- concurrent redemptions of the same code serialize: the second blocks, then re-evaluates against
-- the first's committed `used_by`, finds it non-null, and raises. (The old client-side flow leaned
-- on the UPDATE policy's `used_by is null` USING clause for this; the lock is the equivalent
-- guarantee now that the UPDATE happens inside a function.)
--
-- The raised exception is deliberately IDENTICAL for not-found, expired, and already-used - the
-- three cases are indistinguishable to the caller, so a caller cannot use this function as an
-- oracle to test whether an arbitrary code string exists. friendGroupApi.ts's joinGroup() already
-- surfaced exactly this wording ("Invite code not found, expired, or already used.") for the same
-- reason, so the user-visible message is unchanged by this migration.
--
-- `on conflict do nothing` on the membership insert covers the legitimate case of a user who is
-- already a member of the group redeeming a further code for it - the code is still consumed, and
-- the caller still gets their existing membership row back, rather than the whole call failing on
-- a duplicate-key error. group_memberships' INSERT policy is bypassed here (SECURITY DEFINER), but
-- that policy's has_redeemed_invite_code() gate is not thereby weakened: it remains in force for
-- any direct client insert, and after this migration it can only ever find codes that were
-- redeemed through this function.
create or replace function public.redeem_invite_code(p_code text)
returns group_memberships
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_group_id uuid;
  v_membership group_memberships;
begin
  if v_user_id is null then
    raise exception 'Not signed in.';
  end if;

  select ic.group_id
    into v_group_id
    from invite_codes ic
    where ic.code = p_code
      and ic.used_by is null
      and ic.expires_at > now()
    for update;

  if v_group_id is null then
    raise exception 'Invite code not found, expired, or already used.';
  end if;

  update invite_codes
     set used_by = v_user_id
   where code = p_code;

  insert into group_memberships (group_id, user_id)
  values (v_group_id, v_user_id)
  on conflict (group_id, user_id) do nothing;

  select gm.*
    into v_membership
    from group_memberships gm
   where gm.group_id = v_group_id
     and gm.user_id = v_user_id;

  return v_membership;
end;
$$;

revoke all on function public.redeem_invite_code(text) from public;
grant execute on function public.redeem_invite_code(text) to authenticated, service_role;
