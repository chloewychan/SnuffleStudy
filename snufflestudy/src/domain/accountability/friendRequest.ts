// One shape backs all three kinds of friend-approval request: unlocking a site mid-session, a
// friend-approved temporary passcode for a hard-blocked site, and ending a hard-restricted
// session early. Kind-specific columns (hostname/expiresAt) are null for kinds that don't use
// them, matching the database's own check constraints.
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
