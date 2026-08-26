// v3.4 Task 3: replaces tempPasscodeRequest.ts/sessionEndRequest.ts (and the UnlockRequest type
// that used to live inline in unlockRequestApi.ts) with one shape backing all three kinds of
// friend-approval request (unlocking a site mid-session, a friend-approved temporary passcode for
// a hard-blocked site, ending a hard-restricted session early). See friend_requests' own migration
// (supabase/migrations/20260815000041_v3.4_friend_requests.sql) for the exact column set this
// mirrors - kind-specific columns (hostname/expires_at) are simply null for kinds that don't use
// them, matching that table's own check constraints.
export type FriendRequestKind = "site_unlock" | "site_temp_pass" | "session_end";
export type FriendRequestStatus = "pending" | "approved" | "denied";

export interface FriendRequest {
  id: string;
  kind: FriendRequestKind;
  requesterUserId: string;
  // null = "any of the requester's friends can resolve it" (site_unlock's group-wide/
  // first-responder-wins shape); a real id = "only this friend" (site_temp_pass's assigned-friend
  // shape). session_end also uses null, mirroring unlock_requests' current behavior.
  friendUserId: string | null;
  message: string | null;
  status: FriendRequestStatus;
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  hostname: string | null;
  sessionId: string;
  expiresAt: number | null;
}
