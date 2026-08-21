-- v2 Task 5: Accountability layer schema.
-- Column names/types are transcribed exactly from docs/V2_Implementation_Plan.md's Task 5
-- schema block — later tasks (6-14) build against these exact tables/columns, so nothing
-- here should be renamed or retyped without updating the plan.
--
-- Judgment calls not explicit in the plan text, made here:
-- - `id uuid primary key` columns default to gen_random_uuid() (idiomatic Supabase/Postgres;
--   the plan doesn't say otherwise and every later task's API needs inserts to work without
--   each one separately generating a UUID).
-- - `status`/`delivered_via` text columns get CHECK constraints for the literal value sets
--   the plan already enumerates inline (e.g. 'pending' | 'approved' | 'denied') - this encodes
--   the spec, it doesn't add anything beyond it.
-- - `session_status_events.type` is NOT constrained to a fixed set: the plan describes it as
--   "SessionEventType-shaped, e.g. SESSION_STARTED" (an example, not an exhaustive list), and
--   that TypeScript union is extended additively elsewhere in v2 - a hardcoded CHECK here would
--   require this migration to track that union's growth.
-- - `producer_tag_sends` has no `id`/primary key because the plan's schema block doesn't list
--   one for it (unlike every other table, which does) - left as specified, not improvised.

create extension if not exists pgcrypto;

create table friend_groups (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  owner_user_id  uuid not null references auth.users(id),
  created_at     timestamptz not null default now()
);

create table group_memberships (
  group_id   uuid not null references friend_groups(id),
  user_id    uuid not null references auth.users(id),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table invite_codes (
  code        text primary key,
  group_id    uuid not null references friend_groups(id),
  created_by  uuid not null references auth.users(id),
  expires_at  timestamptz not null,
  used_by     uuid references auth.users(id)
);

create table friendship_settings (
  user_id                 uuid not null references auth.users(id),
  friend_user_id          uuid not null references auth.users(id),
  receive_live_nudges     boolean not null default true,
  send_live_nudges        boolean not null default true,
  receive_daily_digest    boolean not null default true,
  nudge_cooldown_seconds  integer not null default 300,
  primary key (user_id, friend_user_id)
);

create table session_status_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id),
  session_id     text not null,
  type           text not null,
  display_label  text not null,
  occurred_at    timestamptz not null
);

create table unlock_requests (
  id                  uuid primary key default gen_random_uuid(),
  session_id          text not null,
  requester_user_id   uuid not null references auth.users(id),
  hostname            text not null,
  status              text not null check (status in ('pending', 'approved', 'denied')),
  requested_at        timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         uuid references auth.users(id)
);

create table temp_passcode_requests (
  id                  uuid primary key default gen_random_uuid(),
  session_id          text not null,
  hostname            text not null,
  requester_user_id   uuid not null references auth.users(id),
  friend_user_id      uuid not null references auth.users(id),
  status              text not null check (status in ('pending', 'approved', 'denied', 'expired')),
  code_hash           text not null,
  expires_at          timestamptz not null,
  delivered_via       text not null check (delivered_via in ('email', 'email+in_app'))
);

create table study_rooms (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  owner_user_id  uuid not null references auth.users(id),
  created_at     timestamptz not null default now()
);

create table study_room_participants (
  room_id    uuid not null references study_rooms(id),
  user_id    uuid not null references auth.users(id),
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (room_id, user_id, joined_at)
);

create table producer_tags (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id),
  audio_url    text not null,
  duration_ms  integer not null,
  created_at   timestamptz not null default now()
);

create table producer_tag_sends (
  tag_id              uuid not null references producer_tags(id),
  sender_user_id      uuid not null references auth.users(id),
  recipient_user_id   uuid references auth.users(id),
  recipient_room_id   uuid references study_rooms(id),
  sent_at             timestamptz not null default now()
);
