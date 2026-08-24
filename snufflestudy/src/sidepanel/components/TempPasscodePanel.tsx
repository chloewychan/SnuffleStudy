import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { TempPasscodeRequest } from "../../domain/accountability/tempPasscodeRequest";
import { SignInForm } from "../../shared/ui/SignInForm";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";

interface TempPasscodePanelProps {
  onClose: () => void;
}

// v2 Task 12: friend-side "approve/deny a temporary passcode request" panel - mirrors
// UnlockRequestPanel.tsx's "Requests from friends" section/self-id-loading pattern closely (same
// sendMessage-only convention, same self-identity-known-before-filtering guard), kept as its own
// component rather than folded into UnlockRequestPanel.tsx for historical continuity with that
// split, even though v3.3 Task 10 removed the one thing that originally justified a separate
// component (a plaintext code that needed prominent display/copy UI) - an approved request now
// simply leaves the pending list, no further UI needed on the approver's side.
//
// Same lookback window/rationale as UnlockRequestPanel.tsx's LOOKBACK_MS - a point-in-time view of
// recent activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll alarm,
// v2 Task 12's pollTempPasscodeUpdates, for chrome.notifications toasts).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function TempPasscodePanel({ onClose }: TempPasscodePanelProps) {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  // v3.2 Task 2: distinguishes "AUTH_GET_SESSION hasn't resolved yet" from "confirmed signed
  // out" - without it, the sign-in prompt below would flash for a signed-in user too, since it
  // replaces this section's body rather than just filtering an already-rendered list.
  const [selfLoaded, setSelfLoaded] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);

  const [requests, setRequests] = useState<TempPasscodeRequest[] | null>(null);
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
        console.error("Failed to load current user for temp passcode requests", err);
        setSelfError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSelfLoaded(true));
  }

  function loadRequests() {
    setLoading(true);
    setError(null);
    sendMessage<{ ok: boolean; requests?: TempPasscodeRequest[]; error?: string }>({
      type: "TEMP_PASSCODE_REQUESTS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok || !res.requests) {
          setError(res.error ?? "Could not load temporary passcode requests.");
          return;
        }
        setRequests(res.requests);
      })
      .catch((err) => {
        console.error("Failed to fetch temp passcode requests", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadSelf();
    loadRequests();
  }, []);

  function handleApprove(requestId: string) {
    setResolvingId(requestId);
    setResolveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "TEMP_PASSCODE_APPROVE",
      payload: { requestId },
    })
      .then((res) => {
        if (!res.ok) {
          setResolveError(res.error ?? "Could not approve that request.");
          return;
        }
        setRequests((prev) =>
          (prev ?? []).map((r) => (r.id === requestId ? { ...r, status: "approved" } : r))
        );
      })
      .catch((err) => {
        console.error("Failed to approve temp passcode request", err);
        setResolveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResolvingId(null));
  }

  function handleDeny(requestId: string) {
    setResolvingId(requestId);
    setResolveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "TEMP_PASSCODE_DENY",
      payload: { requestId },
    })
      .then((res) => {
        if (!res.ok) {
          setResolveError(res.error ?? "Could not deny that request — a friend may have already answered it.");
          loadRequests();
          return;
        }
        setRequests((prev) =>
          (prev ?? []).map((r) => (r.id === requestId ? { ...r, status: "denied" } : r))
        );
      })
      .catch((err) => {
        console.error("Failed to deny temp passcode request", err);
        setResolveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResolvingId(null));
  }

  // Guarded on selfUserId !== null, not just "falsy" - mirrors UnlockRequestPanel.tsx's identical
  // guard/comment: until loadSelf()'s round trip resolves, who-am-I is genuinely unknown, so
  // rendering an empty list avoids a flash of the wrong content if loadRequests() resolves first.
  const pendingForMe =
    selfUserId === null
      ? []
      : (requests ?? []).filter((r) => r.status === "pending" && r.friendUserId === selfUserId);

  // v3.3 Task 8: resolves each requester's userId to their human_name (falling back to the raw
  // id, same as before this task, when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(pendingForMe.map((r) => r.requesterUserId));

  return (
    <div className="temp-passcode-panel">
      <header className="temp-passcode-panel__header">
        <h2>Temporary passcode requests</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {selfError && <p role="alert">Couldn't verify sign-in: {selfError}.</p>}
      {resolveError && <p role="alert">{resolveError}</p>}

      <section>
        <h3>Requests from friends</h3>
        {/* Requires !selfError too - a failed/rejected AUTH_GET_SESSION call means sign-in
            status is genuinely unknown, not confirmed signed out, so it falls through to the
            normal (pre-Task-2) rendering below; selfError's own alert above already surfaces
            that failure. */}
        {selfLoaded && selfUserId === null && !selfError ? (
          <div className="temp-passcode-panel__sign-in">
            <p>Sign in to see or approve temporary passcode requests from friends.</p>
            <SignInForm
              onSignedIn={(session) => {
                setSelfUserId(session.user.id);
                loadRequests();
              }}
            />
          </div>
        ) : (
          <>
            {pendingForMe.length === 0 && !loading && !error && (
              <p>No pending temporary passcode requests.</p>
            )}
            {pendingForMe.length > 0 && (
              <ul>
                {pendingForMe.map((r) => (
                  <li key={r.id}>
                    <span>
                      {displayName(r.requesterUserId)} wants a temporary passcode for {r.hostname}
                    </span>
                    {/* v3.3 Task 11: r.message is optional - only rendered when present, so a
                        request created without one (the field is optional on LockedPage.tsx)
                        renders exactly as it did before this task, no empty placeholder text. */}
                    {r.message && <p className="temp-passcode-panel__message">"{r.message}"</p>}
                    <button
                      type="button"
                      onClick={() => handleApprove(r.id)}
                      disabled={resolvingId === r.id}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeny(r.id)}
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
      {error && <p role="alert">Couldn't load requests: {error}. Please try again.</p>}
    </div>
  );
}
