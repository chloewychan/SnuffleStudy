// v2 Task 12: Temporary Passcodes for Hard Mode.
// v3.3 Task 10: the human-relayed code is gone entirely - approval alone is the security
// boundary now (both Edge Functions already verified caller identity server-side; the code only
// ever added friction). codeHash/codeSalt/failedAttempts/lockedUntil are dropped from this type
// to match temp_passcode_requests' schema after migration
// 20260815000036_v3.3_temp_passcode_no_code.sql drops the corresponding columns.
export interface TempPasscodeRequest {
  id: string;
  sessionId: string;
  hostname: string;
  friendUserId: string;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: number;

  // requesterUserId: necessary (not just nice-to-have) - without it, neither the requester-side
  // LockedPage.tsx nor the friend-side review panel could tell "is this row mine to claim, or
  // mine to approve/deny" apart, mirrors unlockRequestApi.ts's UnlockRequest.requesterUserId.
  requesterUserId: string;

  // v3.3 Task 11: optional free-text explanation the requester can attach ("Why do you need
  // this? (optional)" on LockedPage.tsx), shown to the approving friend in TempPasscodePanel.tsx
  // alongside the requester/hostname line. `string | null`, not `string | undefined` - matches
  // this column's actual nullable-text shape in temp_passcode_requests (migration
  // 20260815000037_v3.3_temp_passcode_message.sql) and this codebase's established convention for
  // an optional DB column surfaced on a domain type (e.g. UnlockRequest's own nullable fields).
  message: string | null;
}
