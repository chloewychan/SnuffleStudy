-- v2 Task 10: Privacy controls and notification preferences.
--
-- This migration has three parts, matching the task brief:
--
-- Part A - closes a prerequisite gap Task 7's own report flagged: no friendship_settings row was
-- ever auto-created for a user pair (createGroup()'s owner self-membership and joinGroup()'s
-- invite-code redemption both only ever wrote group_memberships, never friendship_settings). With
-- no row, every existing visibility/nudge helper (friend_has_granted_live_visibility,
-- can_send_nudge, friend_has_granted_digest_visibility) denies by default - Tasks 6-9's entire
-- feature set has therefore been unusable by real users so far, only reachable by verify-*.mjs
-- scripts manually inserting rows. Fixed here with an AFTER INSERT trigger on group_memberships
-- (see create_friendship_settings_for_new_member() below) rather than duplicating creation logic
-- in friendGroupApi.ts, so every path that creates a membership row is covered uniformly.
--
-- Part B - five new per-field privacy toggles (distraction attempts, current domain, goal text,
-- intervention count, full history) with real RLS/RPC enforcement, not just UI hiding. Skips
-- "time remaining" from the plan's six-field list entirely - a controller-approved, deliberate
-- scope decision (see this task's report): it is an inherently live/streaming value, and this
-- product deliberately chose event-based (not streaming) friend-activity delivery throughout
-- Tasks 6-9 (docs/Draft1_Architecture_Overview.md's "Friend-event delivery" section); building it
-- would require a new delivery architecture that contradicts that established design, not a
-- straightforward RLS/schema addition like the other five fields.
--
-- Part C (the three local notification-preference fields - live-nudge/digest toggles, quiet
-- hours) has NO server-side component at all - it's implemented entirely in
-- src/domain/settings/userSettings.ts and src/background/alarmHandlers.ts. Those gate whether
-- *this device* shows a chrome.notifications toast for data it has already legitimately received,
-- not whether data is accessible - there is no security boundary to enforce here, unlike Part B.
-- Nothing in this migration corresponds to Part C; see this task's report for the full rationale.
--
-- Judgment call, documented here per this task's instructions: migration 20260815000011's own
-- comment flagged a further, broader gap adjacent to this one - friendship_settings' INSERT
-- policy (20260815000002) has no group-membership check at all, so any authenticated user can
-- still write a settings row naming an arbitrary stranger as friend_user_id. This migration does
-- NOT fix that. Two reasons: (1) this task's brief is explicit that Part A's CRUD surface needs
-- "no new RLS ... for the CRUD itself, only for the new columns' read-visibility semantics" -
-- tightening the pre-existing INSERT policy is outside that explicit boundary; (2) confirmed by
-- actually reading scripts/verify-nudges.mjs, it exercises exactly the case a tightened policy
-- would break (S inserts a friendship_settings row toward R as S's own authenticated client, with
-- no shared group between S and R anywhere in that script) - fixing this here would require
-- rewriting an unrelated, already-passing verification script's setup, which is a materially
-- different and riskier change than this task asked for. Left open, exactly as 20260815000011
-- flagged it, for a future task to close deliberately.

-- === Part A: auto-create friendship_settings rows on group join ===

-- Fires once per new group_memberships row (every path that grants membership: createGroup()'s
-- owner self-membership, joinGroup()'s invite-code redemption, and any future path - see this
-- migration's header comment for why a trigger here beats duplicating creation logic per call
-- site). For every OTHER existing member of the same group, creates both directions of a
-- friendship_settings row (new user -> existing member, existing member -> new user) with every
-- column at its schema default. `on conflict ... do nothing` handles the case where a pair
-- already has rows from a previously shared group (e.g. two users share group A, already have
-- rows from A's own trigger firing, then also join group B together - B's trigger firing must not
-- clobber whatever they've since customized via friendshipSettingsApi.ts).
--
-- SECURITY DEFINER (matching every other cross-table helper in this schema since
-- 20260815000003) so the insert bypasses friendship_settings' own RLS entirely, regardless of
-- which role's session actually performed the group_memberships insert (a real authenticated
-- user via joinGroup(), or a service-role/admin insert in a verify-*.mjs script) - the function
-- runs as its owning role, never subjected to FORCE ROW LEVEL SECURITY on tables that role owns,
-- identical to is_group_member()/friend_has_granted_live_visibility()'s existing bypass pattern.
--
-- The new member's own row (`gm.user_id <> new.user_id`) is excluded from both directions - a
-- friendship_settings row about yourself is meaningless and would also violate nothing (no unique
-- constraint prevents user_id = friend_user_id), just noise this trigger should never produce.
create or replace function public.create_friendship_settings_for_new_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into friendship_settings (user_id, friend_user_id)
  select new.user_id, gm.user_id
  from group_memberships gm
  where gm.group_id = new.group_id
    and gm.user_id <> new.user_id
  on conflict (user_id, friend_user_id) do nothing;

  insert into friendship_settings (user_id, friend_user_id)
  select gm.user_id, new.user_id
  from group_memberships gm
  where gm.group_id = new.group_id
    and gm.user_id <> new.user_id
  on conflict (user_id, friend_user_id) do nothing;

  return new;
end;
$$;

create trigger group_memberships_create_friendship_settings
  after insert on group_memberships
  for each row
  execute function public.create_friendship_settings_for_new_member();

-- === Part B: five new per-field privacy toggles ===

-- Defaults to false ("most-private-by-default"), a deliberately DIFFERENT default from the three
-- pre-existing columns (receive_live_nudges/send_live_nudges/receive_daily_digest, all default
-- true - Task 5's original choice for the nudge/digest axis). These five are the more sensitive,
-- newer fields (docs/Draft1_Architecture_Overview.md's "Privacy controls" list: goal text,
-- distraction attempts, current domain, intervention count, full history) - "the default should
-- be minimal visibility" per that same doc, so a newly-created row (whether from this migration's
-- trigger or a future manual insert) grants nothing extra until the subject explicitly opts a
-- specific friend into each one.
alter table friendship_settings
  add column share_distraction_attempts boolean not null default false,
  add column share_current_domain       boolean not null default false,
  add column share_goal_text            boolean not null default false,
  add column share_intervention_count   boolean not null default false,
  add column share_full_history         boolean not null default false;

-- Nullable, additive, and NEVER selected by the existing plain `.select()` call in
-- sessionStatusSyncApi.ts's queryEventsSince (that call is narrowed to an explicit column list in
-- the same commit that applies this migration - see that file's comment) - Postgres RLS is
-- row-level only, so a single session_status_events row cannot have hostname/goal_text visible to
-- one viewer and hidden from another via a table policy alone. These two columns exist so the
-- real values can be captured at write time (recordStatusEvent, extended in the same commit); the
-- read-side redaction is enforced entirely by the RPC functions below, never by relying on RLS
-- column-level tricks (which plain Postgres RLS does not support) or client-side filtering.
alter table session_status_events
  add column hostname   text,
  add column goal_text   text;

-- users_share_a_group: "do these two users currently share ANY group membership" - the same
-- double-self-join-on-group_memberships shape already proven live (without recursion) by
-- session_status_events' (20260815000006), unlock_requests' (20260815000008), and daily_digests'
-- (20260815000011) policies, factored into one SECURITY DEFINER helper here rather than repeated
-- inline five more times below. This is NOT the same shape as is_group_member(group_id, user_id)
-- from 20260815000003 (that checks membership in one SPECIFIC group; this checks "any group in
-- common between two users", which is what every new helper below needs).
create or replace function public.users_share_a_group(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from group_memberships gm_a
    join group_memberships gm_b on gm_b.group_id = gm_a.group_id
    where gm_a.user_id = p_user_a and gm_b.user_id = p_user_b
  );
$$;

revoke all on function public.users_share_a_group(uuid, uuid) from public;
grant execute on function public.users_share_a_group(uuid, uuid) to authenticated, service_role;

-- The five new field-specific visibility helpers. Each embeds the group-membership floor
-- DIRECTLY (via users_share_a_group above) inside its own boolean expression, not left to be
-- supplied only by whatever policy happens to call it - this is the exact gap 20260815000011's
-- fix round had to close for friend_has_granted_digest_visibility (that function checked only the
-- opt-in row, leaving the group floor to the calling policy, which the original policy forgot to
-- add). Every one of these five checks: (a) subject and viewer share a group, AND (b) the
-- SUBJECT's own friendship_settings row (user_id = subject, friend_user_id = viewer) has the
-- relevant share_* column set true - "the subject controls visibility of their own data" is this
-- codebase's established model (friend_has_granted_live_visibility's exact shape, 20260815000006).
create or replace function public.friend_has_granted_distraction_visibility(
  p_subject_user_id uuid,
  p_viewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select users_share_a_group(p_subject_user_id, p_viewer_user_id)
    and exists (
      select 1 from friendship_settings
      where user_id = p_subject_user_id
        and friend_user_id = p_viewer_user_id
        and share_distraction_attempts = true
    );
$$;

create or replace function public.friend_has_granted_domain_visibility(
  p_subject_user_id uuid,
  p_viewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select users_share_a_group(p_subject_user_id, p_viewer_user_id)
    and exists (
      select 1 from friendship_settings
      where user_id = p_subject_user_id
        and friend_user_id = p_viewer_user_id
        and share_current_domain = true
    );
$$;

create or replace function public.friend_has_granted_goal_visibility(
  p_subject_user_id uuid,
  p_viewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select users_share_a_group(p_subject_user_id, p_viewer_user_id)
    and exists (
      select 1 from friendship_settings
      where user_id = p_subject_user_id
        and friend_user_id = p_viewer_user_id
        and share_goal_text = true
    );
$$;

create or replace function public.friend_has_granted_intervention_count_visibility(
  p_subject_user_id uuid,
  p_viewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select users_share_a_group(p_subject_user_id, p_viewer_user_id)
    and exists (
      select 1 from friendship_settings
      where user_id = p_subject_user_id
        and friend_user_id = p_viewer_user_id
        and share_intervention_count = true
    );
$$;

create or replace function public.friend_has_granted_full_history_visibility(
  p_subject_user_id uuid,
  p_viewer_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select users_share_a_group(p_subject_user_id, p_viewer_user_id)
    and exists (
      select 1 from friendship_settings
      where user_id = p_subject_user_id
        and friend_user_id = p_viewer_user_id
        and share_full_history = true
    );
$$;

revoke all on function public.friend_has_granted_distraction_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_domain_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_goal_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_intervention_count_visibility(uuid, uuid) from public;
revoke all on function public.friend_has_granted_full_history_visibility(uuid, uuid) from public;
grant execute on function public.friend_has_granted_distraction_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_domain_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_goal_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_intervention_count_visibility(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.friend_has_granted_full_history_visibility(uuid, uuid)
  to authenticated, service_role;

-- Row-level policy change: DISTRACTION_ATTEMPT-type rows now need the pre-existing baseline gate
-- (shared group + send_live_nudges, unchanged) AND friend_has_granted_distraction_visibility -
-- additive, not a replacement. Every other event type (SESSION_STARTED, SESSION_COMPLETED, etc.)
-- keeps exactly the baseline-only gate it already had, so "active/completed status" stays the
-- default floor per the architecture doc's privacy list. Own-row visibility
-- ("own session events always readable", 20260815000002) is untouched - a user can always see
-- their own events regardless of type.
drop policy "group members can read visible friend session events" on session_status_events;
create policy "group members can read visible friend session events"
  on session_status_events for select
  using (
    exists (
      select 1 from group_memberships gm_self
      join group_memberships gm_owner on gm_owner.group_id = gm_self.group_id
      where gm_self.user_id = auth.uid()
        and gm_owner.user_id = session_status_events.user_id
    )
    and friend_has_granted_live_visibility(session_status_events.user_id, auth.uid())
    and (
      session_status_events.type <> 'DISTRACTION_ATTEMPT'
      or friend_has_granted_distraction_visibility(session_status_events.user_id, auth.uid())
    )
  );

-- === RPC functions: column-level redaction plain RLS cannot express ===
--
-- Deliberate deviation from this codebase's usual `.select()`-only convention (documented here
-- per this task's brief): a single session_status_events row's hostname/goal_text must be visible
-- to one friend and hidden from another, and plain Postgres RLS is row-level only - it cannot
-- make the SAME row's column values differ per requesting role. There is no way to express "friend
-- A sees hostname, friend B doesn't, same row" as a USING clause. These SECURITY DEFINER functions
-- (called via supabase.rpc(...), not .from().select()) compute the per-viewer-redacted value
-- server-side instead, which is the only way to keep the redaction a real server-side guarantee
-- (per the Global Constraint: RLS/server enforcement, not client-side filtering) rather than
-- shipping the real value to the client and trusting it not to render it.

-- fetch_friend_event_details: takes event ids the caller already legitimately received from the
-- narrowed baseline queryEventsSince query (proving row-visibility was already confirmed there).
-- Still independently re-verifies each row's visibility here too (defense-in-depth - a malicious
-- client could pass arbitrary/guessed ids, not just ones it actually received) using the exact
-- same combined check the SELECT policy above applies (own row, OR shared group + baseline +
-- distraction-specific gate for DISTRACTION_ATTEMPT rows) - a row this function wouldn't
-- ultimately be allowed to return via plain RLS is excluded from the result set entirely, not
-- just redacted. For rows that pass, hostname/goal_text are independently NULLed based on
-- friend_has_granted_domain_visibility/friend_has_granted_goal_visibility for THAT row's subject
-- vs. the caller - a friend could be allowed to see the row's existence (baseline) and even its
-- distraction status, but still have hostname/goal_text redacted independently. The subject's own
-- request for their own data (sse.user_id = auth.uid()) always sees the real values - the
-- share_current_domain/share_goal_text toggles govern what FRIENDS see, never the subject's own
-- read of their own data.
create or replace function public.fetch_friend_event_details(p_event_ids uuid[])
returns table (
  id uuid,
  hostname text,
  goal_text text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sse.id,
    case
      when sse.user_id = auth.uid() then sse.hostname
      when friend_has_granted_domain_visibility(sse.user_id, auth.uid()) then sse.hostname
      else null
    end as hostname,
    case
      when sse.user_id = auth.uid() then sse.goal_text
      when friend_has_granted_goal_visibility(sse.user_id, auth.uid()) then sse.goal_text
      else null
    end as goal_text
  from session_status_events sse
  where sse.id = any(p_event_ids)
    and (
      sse.user_id = auth.uid()
      or (
        exists (
          select 1 from group_memberships gm_self
          join group_memberships gm_owner on gm_owner.group_id = gm_self.group_id
          where gm_self.user_id = auth.uid()
            and gm_owner.user_id = sse.user_id
        )
        and friend_has_granted_live_visibility(sse.user_id, auth.uid())
        and (
          sse.type <> 'DISTRACTION_ATTEMPT'
          or friend_has_granted_distraction_visibility(sse.user_id, auth.uid())
        )
      )
    );
$$;

-- fetch_friend_intervention_count: an aggregate over already-synced data - no new capture
-- needed for the count itself (session_status_events already has one row per DISTRACTION_ATTEMPT,
-- since Task 6), only a visibility gate for who's allowed to ask for someone else's count.
-- Raises rather than silently returning 0/null on denial - matching this task's DoD ("the read
-- must fail or omit the field, not just be hidden") with an unambiguous failure a client can
-- distinguish from "legitimately zero distractions" (which is a real, valid 0).
create or replace function public.fetch_friend_intervention_count(
  p_subject_user_id uuid,
  p_since timestamptz default null
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_subject_user_id <> auth.uid()
     and not friend_has_granted_intervention_count_visibility(p_subject_user_id, auth.uid())
  then
    raise exception 'Not authorized to view this user''s intervention count';
  end if;

  select count(*)::integer
    into v_count
    from session_status_events
    where user_id = p_subject_user_id
      and type = 'DISTRACTION_ATTEMPT'
      and (p_since is null or occurred_at > p_since);

  return v_count;
end;
$$;

-- fetch_friend_full_history: unlike fetch_friend_event_details (which works off a pre-vetted id
-- list the caller already legitimately received), this is an entry point on its own - it
-- independently verifies share_full_history visibility up front (raises on denial, same
-- fail-loud convention as fetch_friend_intervention_count above), then returns ALL of the
-- subject's session_status_events rows (not just recent/unseen-since-poll - deliberately
-- unbounded by time, per this task's brief). Even with full_history granted, this still applies
-- the SAME distraction-type-specific extra gate the row-level RLS policy above applies - a friend
-- granted full_history but not share_distraction_attempts sees every other event type in the
-- subject's whole history, but not the DISTRACTION_ATTEMPT rows - "full history" is additive on
-- top of the type-specific gates, not a bypass of them. Applies the identical
-- hostname/goal_text redaction as fetch_friend_event_details.
create or replace function public.fetch_friend_full_history(p_subject_user_id uuid)
returns table (
  id uuid,
  user_id uuid,
  session_id text,
  type text,
  display_label text,
  hostname text,
  goal_text text,
  occurred_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_subject_user_id <> auth.uid()
     and not friend_has_granted_full_history_visibility(p_subject_user_id, auth.uid())
  then
    raise exception 'Not authorized to view this user''s full session history';
  end if;

  return query
    select
      sse.id,
      sse.user_id,
      sse.session_id,
      sse.type,
      sse.display_label,
      case
        when sse.user_id = auth.uid() then sse.hostname
        when friend_has_granted_domain_visibility(sse.user_id, auth.uid()) then sse.hostname
        else null
      end,
      case
        when sse.user_id = auth.uid() then sse.goal_text
        when friend_has_granted_goal_visibility(sse.user_id, auth.uid()) then sse.goal_text
        else null
      end,
      sse.occurred_at
    from session_status_events sse
    where sse.user_id = p_subject_user_id
      and (
        sse.type <> 'DISTRACTION_ATTEMPT'
        or sse.user_id = auth.uid()
        or friend_has_granted_distraction_visibility(sse.user_id, auth.uid())
      )
    order by sse.occurred_at asc;
end;
$$;

revoke all on function public.fetch_friend_event_details(uuid[]) from public;
revoke all on function public.fetch_friend_intervention_count(uuid, timestamptz) from public;
revoke all on function public.fetch_friend_full_history(uuid) from public;
grant execute on function public.fetch_friend_event_details(uuid[]) to authenticated, service_role;
grant execute on function public.fetch_friend_intervention_count(uuid, timestamptz)
  to authenticated, service_role;
grant execute on function public.fetch_friend_full_history(uuid) to authenticated, service_role;
