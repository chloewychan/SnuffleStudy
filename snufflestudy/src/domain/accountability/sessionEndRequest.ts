// v3.3 Task 12: Temporary pass to end a hard-restricted session early.
//
// Mirrors unlockRequestApi.ts's UnlockRequest shape closely (same requester-only, no-assigned-
// friend design - see Decision 1, docs/implementation_plans/V3.3_Implementation_Plan.md), minus
// UnlockRequest's `hostname` field: a session-end request isn't about any particular site, just
// "let me end this session early." Given its own domain/ file (unlike UnlockRequest, which lives
// directly in unlockRequestApi.ts) per the plan's own Interfaces block, which names this file
// explicitly.
export interface SessionEndRequest {
  id: string;
  sessionId: string;
  requesterUserId: string;
  status: "pending" | "approved" | "denied";
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}
