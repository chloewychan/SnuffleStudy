-- v3.3 Task 8: Profiles backend (bunny name / human name).
--
-- BunnyTab.tsx's bunnyName/humanName fields are pure local stub state today (confirmed directly
-- against the current repo before writing this - no `profiles` table exists anywhere in
-- supabase/migrations/*.sql, and friendGroupApi.ts's listMembers()/AccountPage.tsx's "Your
-- friends" section both render bare user_ids today, with listMembers()'s own header comment
-- explicitly naming a future `profiles` table as the way to fix that). This migration adds that
-- table, and Task 8's application-layer changes are what actually wire it up and replace every
-- raw-userId display this plan's Task 8 block names.
--
-- Visibility: self, or anyone sharing a group with the profile's owner - the same "friend-visible
-- data stays row/field-gated by RLS" floor every other friend-facing table in this schema uses,
-- via users_share_a_group(uuid, uuid) (migration 20260815000012_v2_privacy_controls.sql, confirmed
-- present via grep before writing this). A user who shares no group with the profile's owner gets
-- nothing back for that id - not a raw uuid, not an error, just no row (RLS silently filters
-- SELECT, matching this schema's usual behavior).
--
-- No uniqueness constraint on human_name (Decision 4, V3.3_Implementation_Plan.md) - it is a
-- display label, not an identifier; every authorization check in this schema keys off
-- auth.uid()/user_id, never a name.
--
-- No trigger auto-creates a row here (unlike friendship_settings' group_memberships trigger,
-- 20260815000012) - a user's profiles row is created lazily, on their first BunnyTab.tsx save
-- (profileApi.ts's saveMyProfile() upserts). Until then, getMyProfile() returns null and
-- fetchProfilesByIds() simply omits that user from its result - both are real, expected states
-- application code already handles (BunnyTab.tsx's stub-default fallback, useDisplayNames.ts's
-- raw-id fallback), not error conditions.
create table profiles (
  user_id     uuid primary key references auth.users(id),
  human_name  text,
  bunny_name  text,
  updated_at  timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "self or group-mate can read a profile"
  on profiles for select
  using (
    user_id = auth.uid()
    or users_share_a_group(user_id, auth.uid())
  );

create policy "self can insert own profile"
  on profiles for insert
  with check (user_id = auth.uid());

create policy "self can update own profile"
  on profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on profiles to authenticated;
