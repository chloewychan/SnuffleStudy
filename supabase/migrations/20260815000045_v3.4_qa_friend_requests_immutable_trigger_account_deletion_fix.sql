-- v3.4 QA fix: friend_requests_prevent_immutable_column_changes() (20260815000041) blocks
-- delete_account_data()'s own cleanup UPDATE.
--
-- Reproduced live during the V3.4 manual QA pass (docs/qa/V3.4_Two_Account_QA_Script.md item 14):
-- deleting an account that is (or was) the ASSIGNED friend on a RESOLVED friend_requests row fails
-- with "Edge Function returned a non-2xx status code" - traced to delete_account_data()'s own
--   update friend_requests set friend_user_id = null, resolved_by = null where friend_user_id = p_user_id;
-- being rejected by the immutable-columns trigger it's subject to like any other UPDATE, since that
-- trigger has no notion of "this specific caller is allowed to null this one column."
--
-- Root cause, not a workaround: the old unlock_requests table (this trigger's one precedent,
-- unlock_requests_prevent_immutable_column_changes(), 20260815000009) never had a friend_user_id
-- column at all - it was purely group-wide, so this exact conflict could never arise there. Task 3's
-- consolidation (20260815000041) is what first introduced a protected column that ALSO needs to be
-- legitimately nulled by delete_account_data() - the interaction was never exercised.
--
-- Fix: permit exactly one narrow additional transition on friend_user_id - non-null to null (never
-- null to non-null, never non-null to a DIFFERENT non-null value). This is the only transition
-- delete_account_data() ever performs, and no client-facing message (FRIEND_REQUEST_RESOLVE,
-- FRIEND_REQUEST_APPROVE_TEMP_PASS) ever touches friend_user_id in its UPDATE at all - so this
-- doesn't open any new path for a client to reassign a request to a different friend, only lets the
-- one legitimate "the assigned friend's account no longer exists" case through. Also doesn't weaken
-- Decision 3's site_temp_pass approval boundary: that WITH CHECK excludes
-- status = 'approved' and kind = 'site_temp_pass' from the plain-client path regardless of what
-- friend_user_id becomes in the same statement - orthogonal, unaffected by this change.
create or replace function public.friend_requests_prevent_immutable_column_changes()
returns trigger language plpgsql as $$
begin
  if new.kind <> old.kind
    or new.requester_user_id <> old.requester_user_id
    or (
      new.friend_user_id is distinct from old.friend_user_id
      and not (new.friend_user_id is null and old.friend_user_id is not null)
    )
    or new.hostname is distinct from old.hostname
    or new.session_id <> old.session_id
    or coalesce(new.message, '') <> coalesce(old.message, '')
  then
    raise exception 'kind, requester_user_id, friend_user_id, hostname, session_id, and message cannot be changed on a friend request (friend_user_id may only be cleared to null, e.g. when that friend''s account is deleted)';
  end if;
  return new;
end;
$$;
