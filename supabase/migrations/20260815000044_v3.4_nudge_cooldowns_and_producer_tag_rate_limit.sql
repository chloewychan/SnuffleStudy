-- v3.4 Task 8: Unify nudges and Producer Tags into "nudge: written, audio" — independent
-- per-type cooldowns, and rate-limit enforcement extended to producer_tag_sends for the first
-- time (today it has none at all).
--
-- Deviation from the implementation plan, documented here and in
-- docs/reports/v3.4/task-8-report.md: the plan's Task 8 Interfaces section describes this SQL as
-- living in "the same migration file as Task 6's password_set_at addition,
-- 20260815000043_v3.4_nudge_cooldowns_and_producer_tag_rate_limit.sql", with its literal SQL
-- block leading with `alter table profiles add column password_set_at timestamptz; -- Task 6`.
-- Task 6 already ran and shipped its OWN standalone migration
-- (20260815000043_v3.4_profiles_password_set_at.sql, applied live to the dev project before this
-- task started) — that filename is taken and that column already exists on `profiles`. This
-- migration is therefore its own new file at the next free sequential number (20260815000044) and
-- deliberately omits the `password_set_at` line entirely — everything else below matches the
-- plan's SQL block verbatim.
--
-- Depends on Task 2 (are_friends(), live since 20260815000040_v3.4_friendships.sql) — this
-- migration rewrites can_send_nudge() and the producer_tag_sends INSERT policy a second time,
-- on top of Task 2's "friends-model-only" intermediate versions of both (confirmed by reading
-- that migration file directly before writing this one — both already call are_friends()).

-- === friendship_settings: split nudge_cooldown_seconds into independent written/audio columns.
--
-- Postgres backfills every existing row to the literal default on ADD COLUMN ... DEFAULT (a
-- metadata-only operation since PG 11 for a constant default) - no separate UPDATE statement is
-- needed to make this "a real behavior change for existing friend pairs, not just new ones,"
-- exactly as the scope doc requires.
alter table friendship_settings
  add column nudge_cooldown_seconds_written integer not null default 60,
  add column nudge_cooldown_seconds_audio integer not null default 60;

alter table friendship_settings drop column nudge_cooldown_seconds;

-- can_send_nudge(): rewritten again (Task 2 already swapped users_share_a_group()->are_friends();
-- this migration additionally swaps nudge_cooldown_seconds->nudge_cooldown_seconds_written).
create or replace function public.can_send_nudge(
  p_sender_user_id uuid, p_recipient_user_id uuid
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_sender_send_allowed boolean;
  v_recipient_receive_allowed boolean;
  v_cooldown_seconds integer;
  v_last_sent_at timestamptz;
begin
  if not are_friends(p_sender_user_id, p_recipient_user_id) then
    return false;
  end if;

  select send_live_nudges into v_sender_send_allowed
    from friendship_settings
    where user_id = p_sender_user_id and friend_user_id = p_recipient_user_id;
  if not found or v_sender_send_allowed is not true then return false; end if;

  select receive_live_nudges, nudge_cooldown_seconds_written
    into v_recipient_receive_allowed, v_cooldown_seconds
    from friendship_settings
    where user_id = p_recipient_user_id and friend_user_id = p_sender_user_id;
  if not found or v_recipient_receive_allowed is not true then return false; end if;

  select max(sent_at) into v_last_sent_at
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

-- NEW - producer_tag_sends has no cooldown/toggle enforcement at all today (confirmed: its
-- current INSERT policy, live since 20260815000040_v3.4_friendships.sql, only checks
-- are_friends()/room-membership, nothing rate-limiting - and before that migration it only
-- checked users_share_a_group(), same gap). This is the identical shape to can_send_nudge() above,
-- sharing the SAME on/off toggle columns (send_live_nudges/receive_live_nudges - per the scope
-- doc, "both types share one on/off toggle — only the cooldown timers are separate") but its own
-- cooldown column and its own sent_at lookup against producer_tag_sends instead of nudges. Room
-- sends (recipient_room_id) are untouched by this function entirely - it's only ever consulted
-- for the recipient_user_id (DM) branch of producer_tag_sends' INSERT policy below; a room has no
-- single "recipient" to cool down against, and rooms aren't part of this scope.
create or replace function public.can_send_producer_tag_dm(
  p_sender_user_id uuid, p_recipient_user_id uuid
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_sender_send_allowed boolean;
  v_recipient_receive_allowed boolean;
  v_cooldown_seconds integer;
  v_last_sent_at timestamptz;
begin
  if not are_friends(p_sender_user_id, p_recipient_user_id) then
    return false;
  end if;

  select send_live_nudges into v_sender_send_allowed
    from friendship_settings
    where user_id = p_sender_user_id and friend_user_id = p_recipient_user_id;
  if not found or v_sender_send_allowed is not true then return false; end if;

  select receive_live_nudges, nudge_cooldown_seconds_audio
    into v_recipient_receive_allowed, v_cooldown_seconds
    from friendship_settings
    where user_id = p_recipient_user_id and friend_user_id = p_sender_user_id;
  if not found or v_recipient_receive_allowed is not true then return false; end if;

  select max(sent_at) into v_last_sent_at
    from producer_tag_sends
    where sender_user_id = p_sender_user_id and recipient_user_id = p_recipient_user_id;
  if v_last_sent_at is not null
     and v_last_sent_at > now() - make_interval(secs => v_cooldown_seconds) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.can_send_producer_tag_dm(uuid, uuid) from public;
grant execute on function public.can_send_producer_tag_dm(uuid, uuid) to authenticated, service_role;

-- producer_tag_sends INSERT policy: rewritten again (Task 2 already swapped
-- users_share_a_group()->are_friends() in the DM branch; this migration additionally routes that
-- branch through the new cooldown-gated function instead of the bare are_friends() check). Room
-- branch (recipient_room_id) is untouched.
drop policy "senders can create sends for their own tags to an actual friend or a room they belong to" on producer_tag_sends;
create policy "senders can create sends for their own tags to an actual friend or a room they belong to"
  on producer_tag_sends
  for insert
  to authenticated
  with check (
    sender_user_id = auth.uid()
    and is_producer_tag_owner(producer_tag_sends.tag_id, auth.uid())
    and (
      (
        recipient_user_id is not null
        and can_send_producer_tag_dm(sender_user_id, recipient_user_id)
      )
      or (
        recipient_room_id is not null
        and exists (
          select 1 from study_rooms sr
          where sr.id = recipient_room_id
            and (
              sr.owner_user_id = auth.uid()
              or exists (
                select 1 from study_room_participants srp
                where srp.room_id = sr.id and srp.user_id = auth.uid()
              )
            )
        )
      )
    )
  );
