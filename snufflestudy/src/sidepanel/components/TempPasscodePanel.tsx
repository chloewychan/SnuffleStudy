import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { TempPasscodeRequest } from "../../domain/accountability/tempPasscodeRequest";

interface TempPasscodePanelProps {
  onClose: () => void;
}

// v2 Task 12: friend-side "approve/deny a temporary passcode request" panel - mirrors
// UnlockRequestPanel.tsx's "Requests from friends" section/self-id-loading pattern closely (same
// sendMessage-only convention, same self-identity-known-before-filtering guard), kept as its own
// component rather than folded into UnlockRequestPanel.tsx: this feature's approve action returns
// a plaintext code that must be prominently displayed/copyable (a fundamentally different UI
// concern than unlock_requests' plain approve/deny), and this codebase's sidepanel has
// consistently grown one small component per friend-feature (FriendGroupPanel, UnlockRequestPanel)
// rather than accreting unrelated concerns into an existing one.
//
// Same lookback window/rationale as UnlockRequestPanel.tsx's LOOKBACK_MS - a point-in-time view of
// recent activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll alarm,
// v2 Task 12's pollTempPasscodeUpdates, for chrome.notifications toasts).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function TempPasscodePanel({ onClose }: TempPasscodePanelProps) {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [selfError, setSelfError] = useState<string | null>(null);

  const [requests, setRequests] = useState<TempPasscodeRequest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Plaintext codes approve-temp-passcode returns, keyed by request id - kept ONLY in this
  // component's own transient state, never sent anywhere else, never persisted (matches this
  // task's DoD: the code is returned to the approving friend exactly once, meant to be read and
  // relayed out-of-band).
  const [revealedCodes, setRevealedCodes] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
      });
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
    sendMessage<{ ok: boolean; code?: string; error?: string }>({
      type: "TEMP_PASSCODE_APPROVE",
      payload: { requestId },
    })
      .then((res) => {
        if (!res.ok || !res.code) {
          setResolveError(res.error ?? "Could not approve that request.");
          return;
        }
        setRevealedCodes((prev) => ({ ...prev, [requestId]: res.code! }));
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

  function handleCopy(requestId: string, code: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(code)
        .then(() => setCopiedId(requestId))
        .catch((err) => console.error("Failed to copy temp passcode to clipboard", err));
    }
  }

  // Guarded on selfUserId !== null, not just "falsy" - mirrors UnlockRequestPanel.tsx's identical
  // guard/comment: until loadSelf()'s round trip resolves, who-am-I is genuinely unknown, so
  // rendering an empty list avoids a flash of the wrong content if loadRequests() resolves first.
  const pendingForMe =
    selfUserId === null
      ? []
      : (requests ?? []).filter((r) => r.status === "pending" && r.friendUserId === selfUserId);
  const recentlyApprovedByMe =
    selfUserId === null
      ? []
      : (requests ?? []).filter(
          (r) => r.friendUserId === selfUserId && r.status === "approved" && revealedCodes[r.id]
        );

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
        {pendingForMe.length === 0 && !loading && !error && (
          <p>No pending temporary passcode requests.</p>
        )}
        {pendingForMe.length > 0 && (
          <ul>
            {pendingForMe.map((r) => (
              <li key={r.id}>
                <span>
                  {r.requesterUserId} wants a temporary passcode for {r.hostname}
                </span>
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
      </section>

      {recentlyApprovedByMe.length > 0 && (
        <section className="temp-passcode-panel__revealed-codes">
          <h3>Codes to relay to your friend</h3>
          <ul>
            {recentlyApprovedByMe.map((r) => (
              <li key={r.id}>
                <span>{r.hostname}: </span>
                <input
                  type="text"
                  readOnly
                  value={revealedCodes[r.id]}
                  aria-label={`Temporary passcode for ${r.hostname}`}
                />
                <button type="button" onClick={() => handleCopy(r.id, revealedCodes[r.id]!)}>
                  {copiedId === r.id ? "Copied!" : "Copy"}
                </button>
                <p>Tell your friend this code out loud, by text, or however you'd normally reach them - the app never sends it for you.</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button type="button" onClick={loadRequests} disabled={loading}>
        {loading ? "Refreshing…" : "Refresh"}
      </button>
      {error && <p role="alert">Couldn't load requests: {error}. Please try again.</p>}
    </div>
  );
}
