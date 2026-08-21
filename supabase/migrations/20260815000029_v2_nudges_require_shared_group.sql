-- v2 fix round (Important #1): closes a nudge-floor gap found in review of the group-leave
-- follow-up (commits efeecf3, 6180cac; migration not edited here since 20260815000007 is already
-- applied - this is a corrective follow-up, same convention as
-- 20260815000003/000005/000006/000009/000011/000013/000025's fix-round pattern).
--
-- Bug: can_send_nudge() (20260815000007) has always checked only the two friendship_settings
-- toggles (send_live_nudges/receive_live_nudges) and the cooldown - it never checked
-- users_share_a_group() (20260815000012) or any live group_memberships row at all. Every other
-- cross-person visibility helper added since 20260815000012 embeds that group-membership floor
-- directly inside its own boolean expression (friend_has_granted_distraction_visibility,
-- friend_has_granted_domain_visibility, friend_has_granted_goal_visibility, etc. - see that
-- migration's own header comment: "Each embeds the group-membership floor DIRECTLY ... not left
-- to be supplied only by whatever policy happens to call it"). can_send_nudge() predates
-- users_share_a_group() (20260815000007 is chronologically before 20260815000012) and was never
-- retrofitted with the same floor when every sibling helper picked it up - the exact "one route
-- closed, structurally identical sibling left open" pattern this project's reviews keep finding
-- (20260815000011's daily_digests fix and 20260815000025's header comment are the two most recent
-- prior instances).
--
-- Confirmed live: friendship_settings rows are never pruned when a user leaves a group (unlike
-- group_memberships/invite_codes, which now respond to leaving via 20260815000028's DELETE policy
-- and unredeem-invite-code trigger) - so two users who once shared a group, both opted their
-- respective toggles on, and then had one of them leave the group entirely
-- (users_share_a_group(A, B) now false) could still have A successfully send B a nudge: RLS
-- allowed it purely off the stale toggles and cooldown, with zero current relationship between A
-- and B. Two users who once shared a group - even briefly, even long in the past - could keep
-- nudging each other forever.
--
-- Fix: re-declare can_send_nudge() (create or replace - same signature, so no DROP needed and the
-- INSERT policy on nudges doesn't need to change since it already just calls
-- can_send_nudge(sender_user_id, recipient_user_id)) with `users_share_a_group(p_sender_user_id,
-- p_recipient_user_id)` added as an additional required condition alongside the existing toggle
-- and cooldown checks - matching the exact style every users_share_a_group() caller since
-- 20260815000012 already uses. Checked first (short-circuits before either friendship_settings
-- lookup) since it's the cheapest of the three checks and, per the bug above, is now the primary
-- gate a departed group-mate will fail.
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
  if not users_share_a_group(p_sender_user_id, p_recipient_user_id) then
    return false;
  end if;

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
