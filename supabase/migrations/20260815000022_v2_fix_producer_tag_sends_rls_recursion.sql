-- v2 Task 14 fix round 1: fixes infinite RLS recursion on producer_tag_sends surfaced by actually
-- running scripts/verify-producer-tags.mjs against the live project (7 of 32 checks failed, all
-- either directly with "infinite recursion detected in policy for relation producer_tag_sends" or
-- as a downstream consequence of a send row never having been created because of it).
--
-- Root cause: 20260815000021's new INSERT policy on producer_tag_sends ("senders can create sends
-- for their own tags to an actual friend or a room they belong to") checks tag ownership via a raw
-- subquery directly against the RLS-protected producer_tags table:
--
--   exists (select 1 from producer_tags pt where pt.id = producer_tag_sends.tag_id
--           and pt.user_id = auth.uid())
--
-- But producer_tags' own SELECT policy "recipients can read tags sent to them" (20260815000002)
-- itself subqueries back into producer_tag_sends:
--
--   exists (select 1 from producer_tag_sends pts where pts.tag_id = producer_tags.id and (...))
--
-- That's a two-table RLS reference cycle: producer_tag_sends INSERT check -> producer_tags SELECT
-- policy -> producer_tag_sends SELECT policy. Evaluating the INSERT check requires evaluating
-- producer_tags' SELECT policy, which requires evaluating producer_tag_sends' own SELECT policy on
-- the very table whose INSERT is being checked - Postgres's RLS recursion guard rejects this
-- outright, rather than looping. This is the IDENTICAL failure mode 20260815000003 already fixed
-- for group_memberships/study_rooms/study_room_participants (see that migration's own header
-- comment: "Two policies subquery their own table from within their own USING clause" /
-- "study_rooms and study_room_participants additionally form a mutual A-queries-B / B-queries-A
-- cycle"), just on a new table pair this task introduced. 20260815000021's OTHER two subqueries in
-- this same policy (against study_rooms/study_room_participants for the room-send branch) do NOT
-- have this problem: study_rooms'/study_room_participants' own SELECT policies already route
-- through is_room_participant/is_room_owner (SECURITY DEFINER, bypasses RLS - 20260815000003), so
-- there's no cycle back to producer_tag_sends through that path. Only the producer_tags subquery
-- was broken.
--
-- Fix: the standard pattern for this project (20260815000003) - a SECURITY DEFINER helper
-- function. It runs with its owner's privileges, bypassing RLS for the read it does internally, so
-- the policy can reuse the same ownership check without re-triggering producer_tags' RLS (and
-- therefore never re-entering producer_tag_sends' own RLS either).

create or replace function public.is_producer_tag_owner(p_tag_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from producer_tags
    where id = p_tag_id and user_id = p_user_id
  );
$$;

revoke all on function public.is_producer_tag_owner(uuid, uuid) from public;
grant execute on function public.is_producer_tag_owner(uuid, uuid) to authenticated, service_role;

-- producer_tag_sends INSERT: same guarantee as 20260815000021 ("sender must own the tag being
-- sent, and either share a group with recipient_user_id or belong to recipient_room_id"), with
-- only the tag-ownership check routed through the helper function instead of a raw self-subquery
-- into producer_tags.
drop policy "senders can create sends for their own tags to an actual friend or a room they belong to"
  on producer_tag_sends;

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
        and users_share_a_group(sender_user_id, recipient_user_id)
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
