-- v3.4 Task 3: One generalized friend_requests mechanism, replacing unlock_requests/
-- temp_passcode_requests/session_end_requests - three near-identical tables, three RLS policy
-- sets, three *Api.ts files, three approver panels - with one kind-discriminated table, one RLS
-- policy set, one friendRequestApi.ts, one FriendRequestPanel.tsx.
--
-- Filename note: the plan (docs/implementation_plans/V3.4_Implementation_Plan.md) assumed this
-- would be 20260815000042 (on top of an assumed 20260815000041_v3.4_friendships.sql from Task 2).
-- Task 1 never actually consumed a migration number (it was a pure TypeScript extraction, no SQL
-- - see its own report), so Task 2's friendships migration landed as 20260815000040, making this
-- one 20260815000041 - confirmed directly via `ls supabase/migrations/` before writing this file,
-- not assumed from the plan's filename.
--
-- Depends on Task 2's are_friends(uuid, uuid) (20260815000040_v3.4_friendships.sql) - confirmed
-- live before writing this migration.

-- === New friend_requests table ===
create table friend_requests (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('site_unlock', 'site_temp_pass', 'session_end')),
  requester_user_id  uuid not null references auth.users(id),
  friend_user_id     uuid references auth.users(id),  -- null = any friend, first-responder-wins
  message            text,
  status             text not null check (status in ('pending', 'approved', 'denied')),
  requested_at       timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid references auth.users(id),
  hostname           text,       -- site_unlock/site_temp_pass only
  session_id         text not null,  -- required by all three kinds (matches all 3 source tables today)
  expires_at         timestamptz,     -- site_temp_pass only - set exclusively by the Edge Function below
  constraint friend_requests_requester_ne_friend
    check (friend_user_id is null or friend_user_id <> requester_user_id),
  constraint friend_requests_hostname_by_kind check (
    (kind in ('site_unlock', 'site_temp_pass') and hostname is not null)
    or (kind = 'session_end' and hostname is null)
  ),
  constraint friend_requests_expires_at_by_kind
    check (kind = 'site_temp_pass' or expires_at is null)
);

alter table friend_requests enable row level security;

create policy "users can create their own pending friend requests"
  on friend_requests for insert
  with check (
    requester_user_id = auth.uid()
    and status = 'pending'
    and (friend_user_id is null or are_friends(requester_user_id, friend_user_id))
  );

create policy "requester assigned friend or pending-friend can read friend requests"
  on friend_requests for select
  using (
    requester_user_id = auth.uid()
    or friend_user_id = auth.uid()
    or (
      friend_user_id is null
      and status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  );

-- SECURITY-CRITICAL (Decision 3, docs/implementation_plans/V3.4_Implementation_Plan.md) - this
-- policy deliberately does NOT let a plain client UPDATE set status='approved' when
-- kind='site_temp_pass' - that transition must go through the approve-temp-passcode Edge Function
-- (service_role, bypasses RLS entirely), which is what generates expires_at's TTL server-side.
-- Without this exclusion, any authenticated user visible to a pending site_temp_pass request (the
-- assigned friend, per the USING clause) could plain-UPDATE it to approved with expires_at left
-- null (breaking the relock-alarm mechanism - the request would read as "approved" but never
-- auto-relock) or set an arbitrary far-future expiry themselves. Denial has no such server-
-- generated side effect, so it's allowed through this same plain path for all three kinds
-- (Decision 3's "denial harmonization" - today's temp-passcode denial leaves resolved_by null;
-- under this shared path it gets set, matching how unlock_requests/session_end_requests already
-- behave on denial).
--
-- Also preserves the existing requester-can-resolve-their-own-pending-request USING branch for
-- site_unlock/session_end, per Decision 4 - a pre-existing, unmodified shipped behavior (verified
-- directly against unlock_requests'/session_end_requests' live policies before writing this one -
-- see this task's report), NOT something newly introduced by this consolidation. site_temp_pass
-- never had this branch to begin with (temp_passcode_requests' policies never gave the requester
-- an update path at all) - this policy doesn't special-case that away, since the WITH CHECK below
-- already blocks a requester from self-approving a site_temp_pass row regardless of which USING
-- branch let them reach the UPDATE in the first place (a requester who is also, degenerately, the
-- assigned friend_user_id of their own request is already precluded entirely by the
-- friend_requests_requester_ne_friend constraint above).
create policy "requester assigned friend or pending-friend can resolve friend requests"
  on friend_requests for update
  using (
    requester_user_id = auth.uid()
    or friend_user_id = auth.uid()
    or (
      friend_user_id is null
      and status = 'pending'
      and are_friends(requester_user_id, auth.uid())
    )
  )
  with check (
    resolved_by = auth.uid()
    and (
      status = 'denied'
      or (status = 'approved' and kind <> 'site_temp_pass')
    )
  );

grant select, insert, update on friend_requests to authenticated;
grant select, insert, update, delete on friend_requests to service_role;

-- Immutable-columns trigger (Decision 7) - protects identity/context columns from being altered
-- post-creation via the same UPDATE path used to resolve a request. status/resolved_at/
-- resolved_by/expires_at are deliberately NOT included - mutating those is the entire point of
-- resolving a request (and expires_at must remain writable by the service_role Edge Function).
-- Mirrors unlock_requests_prevent_immutable_column_changes() (20260815000009), the one precedent
-- this schema already has for this pattern, generalized to this table's larger column set (the
-- consolidated table now backs three previously-separate concerns behind one UPDATE policy, so
-- protecting kind/requester_user_id/friend_user_id/hostname/session_id/message is a small,
-- low-cost defense-in-depth measure consistent with that existing precedent).
create or replace function public.friend_requests_prevent_immutable_column_changes()
returns trigger language plpgsql as $$
begin
  if new.kind <> old.kind
    or new.requester_user_id <> old.requester_user_id
    or new.friend_user_id is distinct from old.friend_user_id
    or new.hostname is distinct from old.hostname
    or new.session_id <> old.session_id
    or coalesce(new.message, '') <> coalesce(old.message, '')
  then
    raise exception 'kind, requester_user_id, friend_user_id, hostname, session_id, and message cannot be changed on a friend request';
  end if;
  return new;
end;
$$;

create trigger friend_requests_immutable_columns
  before update on friend_requests
  for each row
  execute function public.friend_requests_prevent_immutable_column_changes();

-- === Drop the three old tables and the now-redundant deny_temp_passcode_request() RPC (Decision
-- 3 - denial for all three kinds now goes through the shared plain-UPDATE resolveRequest()) ===
drop function public.deny_temp_passcode_request(uuid);
drop table unlock_requests;
drop table temp_passcode_requests;
drop table session_end_requests;
drop function public.unlock_requests_prevent_immutable_column_changes();

-- === delete_account_data(): friend_requests half of the rewrite. Base body is the ACTUAL live
-- 20260815000040 version (confirmed directly - read that migration's own body before writing
-- this, not assumed from the plan's stale draft) - the study_room_invitees section (out of scope
-- for this task, added by 20260815000039/preserved by Task 2) and the invite_codes user-scoped
-- cleanup (added by Task 2's own fix-round) are both preserved verbatim; ONLY the
-- unlock_requests/temp_passcode_requests/session_end_requests three-statement block is replaced
-- by one friend_requests block below. See this task's own goal comment on the
-- friend_user_id-preservation judgment call this makes.
create or replace function public.delete_account_data(p_user_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audio_urls text[];
begin
  delete from producer_tag_sends
   where sender_user_id = p_user_id
      or recipient_user_id = p_user_id
      or tag_id in (select id from producer_tags where user_id = p_user_id);

  with deleted as (
    delete from producer_tags where user_id = p_user_id
    returning audio_url
  )
  select coalesce(array_agg(audio_url), array[]::text[]) into v_audio_urls from deleted;

  delete from nudges
   where sender_user_id = p_user_id or recipient_user_id = p_user_id;

  delete from daily_digests where subject_user_id = p_user_id;

  delete from coaching_message_requests where user_id = p_user_id;

  delete from session_status_events where user_id = p_user_id;

  delete from profiles where user_id = p_user_id;

  -- === friend_requests: delete the caller's own requests outright. For requests where the
  -- caller was the ASSIGNED friend (friend_user_id = p_user_id): if still pending, delete the row
  -- outright - nulling friend_user_id here would silently turn a friend-specific request into an
  -- any-friend-can-resolve one, a behavior change the requester never asked for and never
  -- consented to. If already resolved, null out friend_user_id and resolved_by instead,
  -- preserving the requester's record that SOME friend answered it - same "null a secondary
  -- reference rather than delete someone else's row" precedent unlock_requests' own resolved_by
  -- handling already established. Order matters: the third statement already nulls resolved_by
  -- for any row it touches, so the fourth statement's later match against those same rows is a
  -- harmless no-op (already null, no longer matches p_user_id).
  delete from friend_requests where requester_user_id = p_user_id;
  delete from friend_requests where friend_user_id = p_user_id and status = 'pending';
  update friend_requests
     set friend_user_id = null, resolved_by = null
   where friend_user_id = p_user_id;
  update friend_requests set resolved_by = null where resolved_by = p_user_id;

  -- study_room_invitees: unchanged, out of scope for this task - preserved verbatim from
  -- 20260815000040/20260815000039.
  delete from study_room_invitees
   where room_id in (select id from study_rooms where owner_user_id = p_user_id);
  delete from study_room_invitees where user_id = p_user_id;

  delete from study_room_participants
   where user_id = p_user_id
     and room_id not in (select id from study_rooms where owner_user_id = p_user_id);

  update producer_tag_sends
     set recipient_room_id = null
   where recipient_room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_room_participants
   where room_id in (select id from study_rooms where owner_user_id = p_user_id);

  delete from study_rooms where owner_user_id = p_user_id;

  delete from friendships where user_id_a = p_user_id or user_id_b = p_user_id;

  -- invite_codes: unchanged, out of scope for this task - preserved verbatim from 20260815000040.
  update invite_codes set used_by = null where used_by = p_user_id;
  delete from invite_codes where created_by = p_user_id;

  delete from friendship_settings
   where user_id = p_user_id or friend_user_id = p_user_id;

  return v_audio_urls;
end;
$$;
