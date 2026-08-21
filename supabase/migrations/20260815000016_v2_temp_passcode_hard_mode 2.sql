-- v2 Task 12: Temporary Passcodes for Hard Mode.
--
-- temp_passcode_requests already exists (Task 5, migration 20260815000001) with columns:
-- id, session_id, hostname, requester_user_id, friend_user_id, status, code_hash, expires_at,
-- delivered_via. Its existing RLS (migration 20260815000002 - "requester or assigned friend can
-- read/update temp passcode requests") is already adequate for this task: friend_user_id is known
-- at creation time (unlike unlock_requests' Task 5 -> Task 8 "pending discovery" gap), so no RLS
-- changes are needed here.

-- code_hash/expires_at were originally declared NOT NULL, which assumed a code (and its expiry)
-- exists at the moment a request is created. That's not how this task's actual flow works: the
-- REQUESTER creates a pending request first; the assigned FRIEND generates the code (and its
-- expiry) later, via approve-temp-passcode. A pending request therefore genuinely has neither yet
-- - both must become nullable to let createRequest's insert succeed at all.
alter table temp_passcode_requests
  alter column code_hash drop not null,
  alter column expires_at drop not null;

-- code_salt: mirrors src/domain/sites/hardBlockCredential.ts's HardBlockCredential.passcodeSalt -
-- the temp code must be hashed with the exact same salted-PBKDF2 discipline v1 uses for its
-- persistent passcode (100,000-iteration PBKDF2-SHA256, random salt), not a weaker scheme. Same
-- nullable-until-approved lifecycle as code_hash/expires_at above.
alter table temp_passcode_requests add column code_salt text;

-- failed_attempts / locked_until: mirrors HardBlockCredential.failedAttempts/lockedUntil, but
-- enforced SERVER-SIDE by redeem-temp-passcode (supabase/functions/redeem-temp-passcode) rather
-- than client-side-resettable local state (v1's HardBlockCredential lives in chrome.storage.local,
-- which anyone with local access to the browser profile could edit/clear to reset a lockout) -
-- this is a meaningful security improvement over v1, not something to weaken to match it exactly.
alter table temp_passcode_requests add column failed_attempts integer not null default 0;
alter table temp_passcode_requests add column locked_until timestamptz;

-- requested_at / resolved_at: neither existed on this table at all (Task 5 never gave it a
-- timestamp column of any kind). Task 6's shared friend-poll alarm/cursor mechanism
-- (src/infrastructure/storage/friendPollState.ts, reused here per this task's brief rather than a
-- new alarm) needs a monotonic "since X" column to poll against, exactly like session_status_
-- events.occurred_at / nudges.sent_at / unlock_requests.requested_at+resolved_at already provide
-- for their own streams - this table is the one exception among the four polled tables that had
-- no such column, so it must gain one to support the poll this task's brief explicitly requires
-- ("extend Task 6's shared poll... add a fifth: pollTempPasscodeUpdates"). Named to match
-- unlock_requests' identical two-column pattern (requested_at set at insert, resolved_at set when
-- status leaves 'pending') for consistency across the two structurally-similar request tables.
alter table temp_passcode_requests add column requested_at timestamptz not null default now();
alter table temp_passcode_requests add column resolved_at timestamptz;

-- Column-level access control: code_hash/code_salt must NEVER be selectable by the `authenticated`
-- role, by either party (requester or assigned friend) - this is a stronger requirement than Task
-- 10's hostname/goal_text gap, which needed per-viewer SECURITY DEFINER RPCs because plain RLS is
-- row-level only and different viewers of the SAME row legitimately need different answers. Here,
-- the answer is the same for every viewer: never expose it, full stop - so Postgres's native
-- column-level GRANT system (independent of, and evaluated before, RLS) is the right tool. This
-- makes a bare `.select()` (or any select naming these two columns) against this table hard-error
-- for the `authenticated` role with "permission denied for column code_hash/code_salt", rather
-- than relying purely on client-side discipline about which columns to list - the same class of
-- bug Task 10 had to fix after the fact in sessionStatusSyncApi.ts's queryEventsSince, closed here
-- at the SQL grant layer from the start. service_role (used only by the three Edge Functions this
-- task adds) is unaffected - this revoke targets `authenticated` only, and service_role's original
-- full-table grant (migration 20260815000003) already covers every column.
revoke select on temp_passcode_requests from authenticated;
grant select (
  id, session_id, hostname, requester_user_id, friend_user_id, status,
  expires_at, delivered_via, failed_attempts, locked_until, requested_at, resolved_at
) on temp_passcode_requests to authenticated;
