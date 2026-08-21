-- v2 Task 7: Predefined nudges, per-friend settings, rate limits.
--
-- Task 5's schema (migration 20260815000001) has no table for nudges at all - it wasn't in the
-- plan's Task 5 schema block, only `friendship_settings` (the per-friend toggles/cooldown a
-- nudge is gated by) was. Nudges need persisted state of their own (you can't enforce a cooldown
-- without recording when nudges happened), so this migration adds it from scratch, following the
-- same numbered-migration convention as 20260815000001-20260815000006.
--
-- This migration is written knowing in advance the two bug classes 20260815000003/000005/000006
-- each had to fix in a *follow-up* migration for earlier tables, so both are handled correctly
-- from the start here rather than re-discovered:
--   1. `alter table ... enable row level security` alone does not grant the underlying SQL-level
--      privilege - `grant ... to authenticated, service_role` is included in this same migration
--      (20260815000003's Bug 1), not deferred to a fix round.
--   2. The INSERT policy's gate (sender's own send_live_nudges toggle, recipient's
--      receive_live_nudges toggle, recipient's declared cooldown) needs to read the
--      *recipient's* friendship_settings row where the recipient is `user_id` and the sender is
--      `friend_user_id` - exactly the row shape friendship_settings' own RLS policy ("users
--      manage only their own settings rows", migration 20260815000002) denies the sender from
--      reading directly, since the sender is `friend_user_id` on that row, not `user_id`. This is
--      the identical cross-table recursion/denial shape 20260815000006's
--      friend_has_granted_live_visibility() fixed for session_status_events - so the INSERT
--      policy below routes through a SECURITY DEFINER helper (can_send_nudge()) from the start,
--      mirroring that function and 20260815000003/000005's is_group_member()/is_group_owner()/
--      has_redeemed_invite_code() pattern, instead of a naive direct subquery that would silently
--      deny every nudge regardless of the toggles' actual values.
--
-- Judgment call: a friendship_settings row is only created when a user explicitly writes one
-- (there is no trigger that creates one automatically on group join - confirmed by grepping this
-- codebase's application code, which has no such write path yet either). So "no row" is treated
-- as "not opted in" (deny), not defaulted to permissive - can_send_nudge() below requires an
-- actual row to exist on both sides, consistent with the architecture overview's "the default
-- should be minimal visibility" stance even though that line is written about session-status
-- visibility specifically, not nudges.

create table nudges (
  id                 uuid primary key default gen_random_uuid(),
  sender_user_id     uuid not null references auth.users(id),
  recipient_user_id  uuid not null references auth.users(id),
  message_id         text not null,
  sent_at            timestamptz not null default now()
);

alter table nudges enable row level security;

grant select, insert, update, delete on nudges to authenticated, service_role;

-- can_send_nudge: the single server-side gate the INSERT policy below relies on. Bundles all
-- three checks (sender's send_live_nudges, recipient's receive_live_nudges, recipient's declared
-- nudge_cooldown_seconds against this pair's most recent nudge) into one SECURITY DEFINER
-- function rather than splitting the sender-side check out as a plain policy-level subquery -
-- the sender's own friendship_settings row (user_id = sender) IS directly readable by the sender
-- under RLS on its own, but keeping every check inside one function avoids relying on that
-- distinction holding forever, and matches this migration's own comment above about being
-- written once, correctly, rather than iterated on.
--
-- Cooldown semantics: "no more than one nudge from S to R within R's declared
-- nudge_cooldown_seconds" (docs/V2_Implementation_Plan.md Task 7 + this task's brief) - the
-- cooldown window is read from the RECIPIENT's row about the SENDER (user_id = recipient,
-- friend_user_id = sender), the same row receive_live_nudges is read from, since it's the
-- recipient who declares how often they're willing to be nudged by this specific friend.
create or replace function public.can_send_nudge(
  p_sender_user_id uuid,
  p_recipient_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sender_send_allowed boolean;
  v_recipient_receive_allowed boolean;
  v_cooldown_seconds integer;
  v_last_sent_at timestamptz;
begin
  -- Sender's own row: "I may nudge this friend."
  select send_live_nudges
    into v_sender_send_allowed
    from friendship_settings
    where user_id = p_sender_user_id and friend_user_id = p_recipient_user_id;

  if not found or v_sender_send_allowed is not true then
    return false;
  end if;

  -- Recipient's row, declared toward the sender: "this friend may nudge me" + the cooldown they
  -- want enforced against this specific friend.
  select receive_live_nudges, nudge_cooldown_seconds
    into v_recipient_receive_allowed, v_cooldown_seconds
    from friendship_settings
    where user_id = p_recipient_user_id and friend_user_id = p_sender_user_id;

  if not found or v_recipient_receive_allowed is not true then
    return false;
  end if;

  select max(sent_at)
    into v_last_sent_at
    from nudges
    where sender_user_id = p_sender_user_id and recipient_user_id = p_recipient_user_id;

  if v_last_sent_at is not null
     and v_last_sent_at > now() - make_interval(secs => v_cooldown_seconds) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.can_send_nudge(uuid, uuid) from public;
grant execute on function public.can_send_nudge(uuid, uuid) to authenticated, service_role;

-- SELECT: "a nudge should be readable by its sender_user_id or recipient_user_id only (no one
-- else - group membership alone doesn't grant nudge visibility, unlike session_status_events)."
create policy "sender or recipient can read their nudges"
  on nudges for select
  using (sender_user_id = auth.uid() or recipient_user_id = auth.uid());

-- INSERT: the sender must be inserting as themselves, and can_send_nudge() must confirm both
-- toggles and the cooldown - this is the server-side rejection the plan requires ("the
-- cooldown/toggle rejection must happen server-side ... never client-side-only"). A denied
-- INSERT surfaces to the client as a generic RLS-violation Postgres error - nudgeApi.ts's
-- sendNudge() translates that into `{ ok: false, error: <friendly message> }` without being able
-- to (or needing to) distinguish which of the three checks failed.
create policy "sender can insert a nudge only when allowed"
  on nudges for insert
  with check (
    sender_user_id = auth.uid()
    and can_send_nudge(sender_user_id, recipient_user_id)
  );
