-- v4.1 Task 11 (item 8): delete_account_data() was never updated to clean up
-- nudge_vault_texts, the new table added by 20260815000046_v4.1_nudge_vault.sql. Confirmed
-- directly against the live function body (pg_get_functiondef) before writing this - no
-- nudge_vault_texts clause existed anywhere in it. Exactly the "new table, forgotten in account
-- deletion" gap this codebase's own QA history has hit before (see the v3.4 QA fixes), and
-- exactly what the plan's own Task 11 definition of done calls out by name.
--
-- Full function body below is CREATE OR REPLACE with one new statement added (delete from
-- nudge_vault_texts where user_id = p_user_id) - every other statement is copied verbatim from
-- the function's current live definition, unchanged, to avoid silently reverting or altering any
-- prior fix layered into this function across 20260815000032/35/38/39/40/41/45.
create or replace function public.delete_account_data(p_user_id uuid)
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- v4.1 Task 11 (item 8): nudge_vault_texts has no FK/cascade relationship to anything else -
  -- a plain delete by owner, same shape as every other "my own rows" cleanup in this function.
  delete from nudge_vault_texts where user_id = p_user_id;

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
$function$;
