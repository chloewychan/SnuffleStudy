-- v2 Task 5: Row Level Security. This is the enforcement mechanism (Global Constraints:
-- "enforced with Postgres Row Level Security, not just client-side filtering") - RLS is
-- enabled on every table from the schema migration, per that table's testable guarantee from
-- the plan where one is given. No policy for an operation = that operation is denied by
-- default; this is intentional wherever the plan doesn't specify a guarantee (see the
-- study_rooms/study_room_participants/producer_tags note below).

alter table friend_groups enable row level security;
alter table group_memberships enable row level security;
alter table invite_codes enable row level security;
alter table friendship_settings enable row level security;
alter table session_status_events enable row level security;
alter table unlock_requests enable row level security;
alter table temp_passcode_requests enable row level security;
alter table study_rooms enable row level security;
alter table study_room_participants enable row level security;
alter table producer_tags enable row level security;
alter table producer_tag_sends enable row level security;

-- friend_groups / group_memberships: "a user can read a group's rows only if they're a
-- member (row exists in group_memberships for their user_id)."
create policy "members can read their groups"
  on friend_groups for select
  using (exists (
    select 1 from group_memberships gm
    where gm.group_id = friend_groups.id and gm.user_id = auth.uid()
  ));

create policy "users can create groups they own"
  on friend_groups for insert
  with check (owner_user_id = auth.uid());

create policy "members can read memberships of their own groups"
  on group_memberships for select
  using (exists (
    select 1 from group_memberships gm2
    where gm2.group_id = group_memberships.group_id and gm2.user_id = auth.uid()
  ));

create policy "users can insert their own membership row"
  on group_memberships for insert
  with check (user_id = auth.uid());

-- invite_codes: "a user can read/use a code only if expires_at is in the future and used_by
-- is null; writing used_by is only valid once." Read access is intentionally not gated on
-- group membership - the whole point of a code is letting a non-member redeem it.
create policy "unexpired unused codes are readable"
  on invite_codes for select
  using (expires_at > now() and used_by is null);

create policy "group members can create invite codes for their group"
  on invite_codes for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from group_memberships gm
      where gm.group_id = invite_codes.group_id and gm.user_id = auth.uid()
    )
  );

-- USING requires the row to currently be unused+unexpired; once a redemption sets used_by,
-- every later attempt fails USING on that same row - "only valid once" falls out of this
-- naturally rather than needing a separate check.
create policy "unused unexpired codes can be redeemed once"
  on invite_codes for update
  using (used_by is null and expires_at > now())
  with check (used_by = auth.uid());

-- friendship_settings: "a user can read/write only rows where user_id = auth.uid(); a user
-- can never read or modify the row where they are the friend_user_id."
create policy "users manage only their own settings rows"
  on friendship_settings for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- session_status_events: "a user can read another user's event only if that other user has a
-- group_memberships row in common with them AND the event's visibility (per
-- friendship_settings) allows it - never just same group alone." Task 10 (privacy
-- controls/notification prefs) adds finer field-level toggles later; the closest visibility
-- flag that exists at this table's creation is friendship_settings.send_live_nudges on the
-- event owner's row for this specific reader.
create policy "own session events always readable"
  on session_status_events for select
  using (user_id = auth.uid());

create policy "group members can read visible friend session events"
  on session_status_events for select
  using (
    exists (
      select 1 from group_memberships gm_self
      join group_memberships gm_owner on gm_owner.group_id = gm_self.group_id
      where gm_self.user_id = auth.uid()
        and gm_owner.user_id = session_status_events.user_id
    )
    and exists (
      select 1 from friendship_settings fs
      where fs.user_id = session_status_events.user_id
        and fs.friend_user_id = auth.uid()
        and fs.send_live_nudges = true
    )
  );

create policy "users can insert their own session events"
  on session_status_events for insert
  with check (user_id = auth.uid());

-- unlock_requests / temp_passcode_requests: "readable/writable only by the requester_user_id
-- or the resolving friend (resolved_by / friend_user_id)."
--
-- Known gap (not a Task 5 blocker, flagged for Task 8): unlock_requests has no
-- "assigned friend" column - only resolved_by, which is null until someone resolves the
-- request. Under this literal policy, no friend can be the FIRST to resolve a pending
-- request, since resolved_by = auth.uid() can't match a null column. Task 5's own definition
-- of done only requires a negative test against an already-resolved request belonging to
-- someone else, which this policy correctly denies. Task 8 (Unlock requests) will need to
-- decide how a friend discovers/claims a pending request - e.g. widening SELECT to common
-- group membership like session_status_events above, or adding a target-friend column.
create policy "requester or resolver can read unlock requests"
  on unlock_requests for select
  using (requester_user_id = auth.uid() or resolved_by = auth.uid());

create policy "users can create their own unlock requests"
  on unlock_requests for insert
  with check (requester_user_id = auth.uid());

create policy "requester or resolver can update unlock requests"
  on unlock_requests for update
  using (requester_user_id = auth.uid() or resolved_by = auth.uid())
  with check (requester_user_id = auth.uid() or resolved_by = auth.uid());

-- temp_passcode_requests DOES have an assigned friend (friend_user_id) from creation, so this
-- one has no equivalent chicken-and-egg gap - the designated friend can see and act on the
-- request the moment it's created.
create policy "requester or assigned friend can read temp passcode requests"
  on temp_passcode_requests for select
  using (requester_user_id = auth.uid() or friend_user_id = auth.uid());

create policy "users can create their own temp passcode requests"
  on temp_passcode_requests for insert
  with check (requester_user_id = auth.uid());

create policy "requester or assigned friend can update temp passcode requests"
  on temp_passcode_requests for update
  using (requester_user_id = auth.uid() or friend_user_id = auth.uid())
  with check (requester_user_id = auth.uid() or friend_user_id = auth.uid());

-- study_rooms / study_room_participants: the plan doesn't give an explicit RLS guarantee for
-- these two (Task 13 owns the feature). Conservative default consistent with the rest of the
-- schema - owner and current participants only - so nothing is over-exposed before Task 13
-- defines real access rules. RLS policies are additive, so Task 13 broadening this later is a
-- normal extension, not a breaking change.
create policy "owner can create study rooms"
  on study_rooms for insert
  with check (owner_user_id = auth.uid());

create policy "owner and participants can read study rooms"
  on study_rooms for select
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1 from study_room_participants srp
      where srp.room_id = study_rooms.id and srp.user_id = auth.uid()
    )
  );

create policy "participants and owner can read room participant rows"
  on study_room_participants for select
  using (
    exists (
      select 1 from study_room_participants srp2
      where srp2.room_id = study_room_participants.room_id and srp2.user_id = auth.uid()
    )
    or exists (
      select 1 from study_rooms sr
      where sr.id = study_room_participants.room_id and sr.owner_user_id = auth.uid()
    )
  );

create policy "users can insert their own participant row"
  on study_room_participants for insert
  with check (user_id = auth.uid());

create policy "users can update their own participant row"
  on study_room_participants for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- producer_tags: same "no explicit guarantee yet" situation as study_rooms (Task 14 owns the
-- feature). Owner manages their own tags; a recipient of a send (per producer_tag_sends'
-- guarantee below) can also read the tag itself, otherwise a delivered tag would be
-- unreadable to the person it was sent to.
create policy "owner can manage their own producer tags"
  on producer_tags for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "recipients can read tags sent to them"
  on producer_tags for select
  using (exists (
    select 1 from producer_tag_sends pts
    where pts.tag_id = producer_tags.id
      and (
        pts.recipient_user_id = auth.uid()
        or exists (
          select 1 from study_room_participants srp
          where srp.room_id = pts.recipient_room_id and srp.user_id = auth.uid()
        )
      )
  ));

-- producer_tag_sends: "readable only by sender_user_id, recipient_user_id, or a member of
-- recipient_room_id."
create policy "sender recipient or room member can read sends"
  on producer_tag_sends for select
  using (
    sender_user_id = auth.uid()
    or recipient_user_id = auth.uid()
    or (
      recipient_room_id is not null
      and exists (
        select 1 from study_room_participants srp
        where srp.room_id = producer_tag_sends.recipient_room_id and srp.user_id = auth.uid()
      )
    )
  );

create policy "senders can create their own sends"
  on producer_tag_sends for insert
  with check (sender_user_id = auth.uid());
