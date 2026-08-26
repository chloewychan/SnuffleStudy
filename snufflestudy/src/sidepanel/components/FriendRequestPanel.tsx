import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";

interface FriendRequestPanelProps {
  // Optional (Task 4's "no dead button in the first place" - this component is built fresh
  // rather than inheriting a Close button from UnlockRequestPanel.tsx/TempPasscodePanel.tsx/
  // SessionEndRequestPanel.tsx, the three components it replaces, all of which had one wired to
  // a no-op wherever they were mounted without somewhere real to close to). Rendered only when a
  // real handler is passed.
  onClose?: () => void;
}

// v3.4 Task 3: replaces UnlockRequestPanel.tsx/TempPasscodePanel.tsx/SessionEndRequestPanel.tsx's
// near-identical "Requests from friends" sections with one panel covering all three kinds -
// approver-only, no `session` prop (Decision 5: the requester-side "request an unlock" section
// that used to live in UnlockRequestPanel.tsx's top half moves to its own RequestUnlockForm.tsx
// instead, session-aware, composed alongside this panel at SidePanelApp.tsx's active-session
// call site). Same self-identity-known-before-filtering guard, same sendMessage-only convention
// (no infrastructure/backend/* import - see messageRouter.ts's architecture note), same
// sign-in-prompt fallback, same lookback window/rationale as every panel it replaces - a
// point-in-time view of recent activity, not itself the delivery mechanism (that's
// alarmHandlers.ts's friend-poll alarm, pollFriendRequestUpdates, for chrome.notifications
// toasts).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

function detailLine(r: FriendRequest, requesterName: string): string {
  if (r.kind === "site_unlock") return `${requesterName} wants to unlock ${r.hostname}`;
  if (r.kind === "site_temp_pass") return `${requesterName} wants a temporary passcode for ${r.hostname}`;
  return `${requesterName} wants to end their session early`;
}

export function FriendRequestPanel({ onClose }: FriendRequestPanelProps) {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  // v3.2 Task 2: distinguishes "AUTH_GET_SESSION hasn't resolved yet" from "confirmed signed
  // out" - without it, the sign-in prompt below would flash for a signed-in user too. Same
  // guard/rationale as every panel this replaces.
  const [selfLoaded, setSelfLoaded] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);

  const [requests, setRequests] = useState<FriendRequest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  function loadSelf() {
    setSelfError(null);
    sendMessage<{ ok: boolean; session?: { user: { id: string } } | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (!res.ok) {
          setSelfError(res.error ?? "Could not verify your sign-in status.");
          return;
        }
        setSelfUserId(res.session?.user.id ?? null);
      })
      .catch((err) => {
        console.error("Failed to load current user for friend requests", err);
        setSelfError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSelfLoaded(true));
  }

  function loadRequests() {
    setLoading(true);
    setError(null);
    sendMessage<{ ok: boolean; requests?: FriendRequest[]; error?: string }>({
      type: "FRIEND_REQUESTS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok || !res.requests) {
          setError(res.error ?? "Could not load friend requests.");
          return;
        }
        setRequests(res.requests);
      })
      .catch((err) => {
        console.error("Failed to fetch friend requests", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadSelf();
    loadRequests();
  }, []);

  function handleResolve(request: FriendRequest, decision: "approved" | "denied") {
    setResolvingId(request.id);
    setResolveError(null);
    // Decision 3: approving a site_temp_pass request must go through the approve-temp-passcode
    // Edge Function - the ONE friend_requests mutation that does not go through the shared
    // FRIEND_REQUEST_RESOLVE path. Denying (any kind) and approving site_unlock/session_end all
    // share the same plain-UPDATE path.
    const usesTempPassApproval = decision === "approved" && request.kind === "site_temp_pass";
    const send = usesTempPassApproval
      ? sendMessage<{ ok: boolean; error?: string }>({
          type: "FRIEND_REQUEST_APPROVE_TEMP_PASS",
          payload: { requestId: request.id },
        })
      : sendMessage<{ ok: boolean; error?: string }>({
          type: "FRIEND_REQUEST_RESOLVE",
          payload: { requestId: request.id, decision },
        });

    send
      .then((res) => {
        if (!res.ok) {
          // Server-side rejection - most commonly another friend already resolved this request
          // first ("first responder wins"). Surfaced inline, then the list is refreshed so this
          // request's real current state (now visible only to the requester and whoever
          // actually resolved it) replaces the stale pending row here - same convention every
          // panel this replaces already used.
          setResolveError(res.error ?? "Could not resolve that request — a friend may have already answered it.");
          loadRequests();
          return;
        }
        setRequests((prev) =>
          (prev ?? []).map((r) => (r.id === request.id ? { ...r, status: decision } : r))
        );
      })
      .catch((err) => {
        console.error("Failed to resolve friend request", err);
        setResolveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResolvingId(null));
  }

  // Guarded on selfUserId !== null, not just "falsy" - mirrors every panel this replaces:
  // until loadSelf()'s round trip resolves, who-am-I is genuinely unknown, so rendering an empty
  // list avoids a flash of the viewer's own pending request if loadRequests() resolves first.
  const pendingFromOthers =
    selfUserId === null
      ? []
      : (requests ?? []).filter((r) => r.status === "pending" && r.requesterUserId !== selfUserId);

  // v3.3 Task 8: resolves each requester's userId to their human_name (falling back to the raw
  // id when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(pendingFromOthers.map((r) => r.requesterUserId));

  return (
    <div className="friend-request-panel">
      <header className="friend-request-panel__header">
        <h2>Friend requests</h2>
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </header>

      {selfError && <p role="alert">Couldn't verify sign-in: {selfError}.</p>}

      <section>
        <h3>Requests from friends</h3>
        {/* Requires !selfError too - a failed/rejected AUTH_GET_SESSION call means sign-in
            status is genuinely unknown, not confirmed signed out, so it falls through to the
            normal rendering below; selfError's own alert above already surfaces that failure. */}
        {selfLoaded && selfUserId === null && !selfError ? (
          <div className="friend-request-panel__sign-in">
            <p>Sign in to see or resolve requests from friends.</p>
            <SignInForm
              onSignedIn={(session) => {
                setSelfUserId(session.user.id);
                loadRequests();
              }}
            />
          </div>
        ) : (
          <>
            {resolveError && <p role="alert">{resolveError}</p>}
            {pendingFromOthers.length === 0 && !loading && !error && (
              <p>No pending requests from friends.</p>
            )}
            {pendingFromOthers.length > 0 && (
              <ul>
                {pendingFromOthers.map((r) => (
                  <li key={r.id}>
                    <span>{detailLine(r, displayName(r.requesterUserId))}</span>
                    {/* v3.3 Task 11: r.message is optional - only rendered when present, same
                        convention TempPasscodePanel.tsx already established. */}
                    {r.message && <p className="friend-request-panel__message">"{r.message}"</p>}
                    <button
                      type="button"
                      onClick={() => handleResolve(r, "approved")}
                      disabled={resolvingId === r.id}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResolve(r, "denied")}
                      disabled={resolvingId === r.id}
                    >
                      Deny
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <button type="button" onClick={loadRequests} disabled={loading}>
        {loading ? "Refreshing…" : "Refresh"}
      </button>
      {error && <p role="alert">Couldn't load friend requests: {error}. Please try again.</p>}
    </div>
  );
}
