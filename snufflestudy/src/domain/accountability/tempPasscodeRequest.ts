// v2 Task 12: Temporary Passcodes for Hard Mode.
//
// Per the plan's literal Deliverables block, this interface still nominally includes codeHash -
// kept here for shape-fidelity with the plan's spec, NOT because any real client-side query ever
// populates it with a genuine value. temp_passcode_requests.code_hash/code_salt are excluded from
// every column list infrastructure/backend/tempPasscodeApi.ts ever requests, and Postgres
// column-level GRANTs (supabase/migrations/20260815000016_v2_temp_passcode_hard_mode.sql) enforce
// this server-side too - a bare `.select()` against this table hard-errors for the `authenticated`
// role rather than silently leaking these two columns (contrast Task 10's hostname/goal_text gap,
// which needed per-viewer SECURITY DEFINER RPCs because RLS alone can't do column-level
// enforcement and different viewers legitimately need different answers there - here, the answer
// is the same for every viewer: never expose it, full stop, so the simpler column-grant mechanism
// is the right tool). Every tempPasscodeApi.ts function that builds a TempPasscodeRequest sets
// codeHash/codeSalt to "" - constant placeholders, never real hash/salt values.
export interface TempPasscodeRequest {
  id: string;
  sessionId: string;
  hostname: string;
  friendUserId: string;
  status: "pending" | "approved" | "denied" | "expired";
  codeHash: string;
  expiresAt: number;

  // Additive beyond the plan's literal spec:
  // - requesterUserId: necessary (not just nice-to-have) - without it, neither the requester-side
  //   LockedPage.tsx nor the friend-side review panel could tell "is this row mine to redeem, or
  //   mine to approve/deny" apart, mirrors unlockRequestApi.ts's UnlockRequest.requesterUserId.
  // - codeSalt: present for type parity with the schema's own new column, subject to the exact
  //   same never-queried-for-real discipline as codeHash above (always "" from any
  //   client-derived object).
  // - failedAttempts/lockedUntil: NOT secret (they reveal nothing about the code itself, only
  //   attempt-count/lockout metadata) - populated with real values, mirroring
  //   HardBlockCredential's identically-named fields (src/domain/sites/hardBlockCredential.ts).
  requesterUserId: string;
  codeSalt: string;
  failedAttempts: number;
  lockedUntil?: number;
}
