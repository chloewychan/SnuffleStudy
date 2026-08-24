import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { SessionEndRequest } from "../../domain/accountability/sessionEndRequest";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";

interface SessionEndRequestPanelProps {
  onClose: () => void;
}

// v3.3 Task 12: friend-side "approve/deny a temporary pass to end a session early" panel - one
// small component per friend-feature, matching this codebase's own established convention (see
// TempPasscodePanel.tsx's/UnlockRequestPanel.tsx's identical split, rather than folding every
// friend-request type into one big panel). Mirrors UnlockRequestPanel.tsx's "Requests from
// friends" section shape closely: same self-identity-known-before-filtering guard, same
// sendMessage-only convention (no infrastructure/backend/* import - see messageRouter.ts's
// architecture note), same sign-in-prompt fallback.
//
// No requester-side "request a temporary pass" section here, unlike UnlockRequestPanel.tsx's own
// requester section - that half of this feature lives on EndSessionControl.tsx instead (the
// hard-restricted end-session prompt itself, not this friends-tab panel), since a session-end
// request only makes sense in the context of the specific session someone is trying to end, which
// this always-visible, no-active-session-aware panel has no notion of. This mirrors
// UnlockRequestPanel.tsx's own `session={null}` treatment in FriendsTab.tsx - the requester side
// there is likewise gated on an active session existing.
//
// Same lookback window/rationale as UnlockRequestPanel.tsx's LOOKBACK_MS - a point-in-time view of
// recent activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll alarm,
// Task 12's pollSessionEndRequestUpdates, for chrome.notifications toasts - notification-only, per
// the Global Constraints note, since ending a session is disruptive and is never auto-applied).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function SessionEndRequestPanel({ onClose }: SessionEndRequestPanelProps) {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  // v3.2 Task 2: distinguishes "AUTH_GET_SESSION hasn't resolved yet" from "confirmed signed
  // out" - without it, the sign-in prompt below would flash for a signed-in user too, same
  // guard/rationale as TempPasscodePanel.tsx/UnlockRequestPanel.tsx.
  const [selfLoaded, setSelfLoaded] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);

  const [requests, setRequests] = useState<SessionEndRequest[] | null>(null);
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
        console.error("Failed to load current user for session-end requests", err);
        setSelfError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSelfLoaded(true));
  }

  function loadRequests() {
    setLoading(true);
    setError(null);
    sendMessage<{ ok: boolean; requests?: SessionEndRequest[]; error?: string }>({
      type: "SESSION_END_REQUESTS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok || !res.requests) {
          setError(res.error ?? "Could not load session-end requests.");
          return;
        }
        setRequests(res.requests);
      })
      .catch((err) => {
        console.error("Failed to fetch session-end requests", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadSelf();
    loadRequests();
  }, []);

  function handleResolve(requestId: string, decision: "approved" | "denied") {
    setResolvingId(requestId);
    setResolveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "SESSION_END_REQUEST_RESOLVE",
      payload: { requestId, decision },
    })
      .then((res) => {
        if (!res.ok) {
          // Server-side rejection - most commonly another friend already resolved this request
          // first ("first responder wins" - see supabase/migrations/
          // 20260815000038_v3.3_session_end_requests.sql). Surfaced inline, then the list is
          // refreshed so this request's real current state replaces the stale pending row here -
          // same convention as UnlockRequestPanel.tsx's handleResolve.
          setResolveError(res.error ?? "Could not resolve that request — a friend may have already answered it.");
          loadRequests();
          return;
        }
        setRequests((prev) =>
          (prev ?? []).map((r) => (r.id === requestId ? { ...r, status: decision } : r))
        );
      })
      .catch((err) => {
        console.error("Failed to resolve session-end request", err);
        setResolveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResolvingId(null));
  }

  // Guarded on selfUserId !== null, not just "falsy" - mirrors UnlockRequestPanel.tsx's/
  // TempPasscodePanel.tsx's identical guard: until loadSelf()'s round trip resolves, who-am-I is
  // genuinely unknown, so rendering an empty list avoids a flash of the viewer's own pending
  // request if loadRequests() resolves first.
  const pendingFromOthers =
    selfUserId === null
      ? []
      : (requests ?? []).filter((r) => r.status === "pending" && r.requesterUserId !== selfUserId);

  // v3.3 Task 8: resolves each requester's userId to their human_name (falling back to the raw id
  // when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(pendingFromOthers.map((r) => r.requesterUserId));

  return (
    <div className="session-end-request-panel">
      <header className="session-end-request-panel__header">
        <h2>Session-end requests</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {selfError && <p role="alert">Couldn't verify sign-in: {selfError}.</p>}

      <section>
        <h3>Requests from friends</h3>
        {/* Requires !selfError too - a failed/rejected AUTH_GET_SESSION call means sign-in
            status is genuinely unknown, not confirmed signed out, so it falls through to the
            normal rendering below; selfError's own alert above already surfaces that failure. */}
        {selfLoaded && selfUserId === null && !selfError ? (
          <div className="session-end-request-panel__sign-in">
            <p>Sign in to see or resolve session-end requests from friends.</p>
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
              <p>No pending session-end requests from friends.</p>
            )}
            {pendingFromOthers.length > 0 && (
              <ul>
                {pendingFromOthers.map((r) => (
                  <li key={r.id}>
                    <span>{displayName(r.requesterUserId)} wants to end their session early</span>
                    <button
                      type="button"
                      onClick={() => handleResolve(r.id, "approved")}
                      disabled={resolvingId === r.id}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResolve(r.id, "denied")}
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
      {error && <p role="alert">Couldn't load session-end requests: {error}. Please try again.</p>}
    </div>
  );
}
