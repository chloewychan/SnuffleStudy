import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { UnlockRequest } from "../../infrastructure/backend/unlockRequestApi";
import type { StudySession, SessionEvent } from "../../domain/session/sessionTypes";

interface UnlockRequestPanelProps {
  // The currently active session, or null if none - the requester-side "request an unlock"
  // section only renders when a non-terminal session is present (there's nothing to unlock a
  // site *for* otherwise). The friend-side "pending requests from others" section renders
  // regardless, same as FriendGroupPanel.tsx is reachable independent of the viewer's own
  // session state.
  session: StudySession | null;
  onClose: () => void;
}

// Mirrors FriendGroupPanel.tsx's identical lookback window/rationale - a point-in-time view of
// recent activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll
// alarm - v2 Task 8 - which tracks its own separate "last checked" cursor via
// friendPollState.ts's getLastUnlockPollAt/setLastUnlockPollAt for chrome.notifications toasts).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

const STATUS_LABEL: Record<UnlockRequest["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
};

const NON_TERMINAL_STATES = new Set(["FOCUSING", "PAUSED", "BREAK"]);

// Per this task's brief: "check whether ... any existing session state cheaply gives you a list
// of 'sites blocked so far this session' to prefill from, but a manual hostname field is an
// acceptable minimum." SESSION_LIST_EVENTS (v1, already exists) already records a hostname on
// every DISTRACTION_ATTEMPT event for the current session - deriving distinct hostnames from
// that is cheap (one existing message, no new backend work) and used as quick-fill buttons
// below, alongside (not instead of) the manual text field.
function distinctBlockedHostnames(events: SessionEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type === "DISTRACTION_ATTEMPT" && event.hostname) {
      seen.add(event.hostname);
    }
  }
  return [...seen];
}

// Requester side (a way to request an unlock for a hostname during an active session, showing
// that request's current status) + friend side (list pending requests from group-mates, with
// approve/deny) in one panel - both driven entirely by sendMessage, no direct
// infrastructure/backend imports beyond types, same convention as FriendGroupPanel.tsx.
export function UnlockRequestPanel({ session, onClose }: UnlockRequestPanelProps) {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [selfError, setSelfError] = useState<string | null>(null);

  const [requests, setRequests] = useState<UnlockRequest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [blockedHostnames, setBlockedHostnames] = useState<string[]>([]);

  const [hostnameInput, setHostnameInput] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
        console.error("Failed to load current user for unlock requests", err);
        setSelfError(err instanceof Error ? err.message : String(err));
      });
  }

  function loadRequests() {
    setLoading(true);
    setError(null);
    sendMessage<{ ok: boolean; requests?: UnlockRequest[]; error?: string }>({
      type: "UNLOCK_REQUESTS_FETCH",
      payload: { sinceTimestamp: Date.now() - LOOKBACK_MS },
    })
      .then((res) => {
        if (!res.ok || !res.requests) {
          setError(res.error ?? "Could not load unlock requests.");
          return;
        }
        setRequests(res.requests);
      })
      .catch((err) => {
        console.error("Failed to fetch unlock requests", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }

  function loadBlockedHostnames() {
    if (!session) {
      setBlockedHostnames([]);
      return;
    }
    sendMessage<{ ok: boolean; events?: SessionEvent[]; error?: string }>({
      type: "SESSION_LIST_EVENTS",
      payload: { sessionId: session.id },
    })
      .then((res) => {
        if (!res.ok || !res.events) return;
        setBlockedHostnames(distinctBlockedHostnames(res.events));
      })
      .catch((err) => {
        // Purely a UI convenience (quick-fill suggestions) - never block the rest of the panel
        // on this failing.
        console.error("Failed to load blocked-site suggestions", err);
      });
  }

  // Re-runs when the active session changes (including going from a session to none, or vice
  // versa) - session?.id is a deliberate, narrow dependency (not every prop this effect
  // touches), since loadBlockedHostnames is the only one of the three that actually varies with
  // the session; loadSelf/loadRequests don't depend on it but are cheap/idempotent to re-run.
  useEffect(() => {
    loadSelf();
    loadRequests();
    loadBlockedHostnames();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above.
  }, [session?.id]);

  function handleCreateRequest(hostname: string) {
    const trimmed = hostname.trim();
    if (!session || !trimmed) return;
    setCreateBusy(true);
    setCreateError(null);
    sendMessage<{ ok: boolean; request?: UnlockRequest; error?: string }>({
      type: "UNLOCK_REQUEST_CREATE",
      payload: { sessionId: session.id, hostname: trimmed },
    })
      .then((res) => {
        if (!res.ok || !res.request) {
          setCreateError(res.error ?? "Could not create that unlock request.");
          return;
        }
        setHostnameInput("");
        setRequests((prev) => [...(prev ?? []), res.request!]);
      })
      .catch((err) => {
        console.error("Failed to create unlock request", err);
        setCreateError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setCreateBusy(false));
  }

  function handleResolve(requestId: string, decision: "approved" | "denied") {
    setResolvingId(requestId);
    setResolveError(null);
    sendMessage<{ ok: boolean; error?: string }>({
      type: "UNLOCK_REQUEST_RESOLVE",
      payload: { requestId, decision },
    })
      .then((res) => {
        if (!res.ok) {
          // Server-side rejection - most commonly another friend already resolved this request
          // first ("first responder wins" - see supabase/migrations/
          // 20260815000008_v2_unlock_request_group_visibility.sql). Surfaced inline, then the
          // list is refreshed so this request's real current state (now visible only to the
          // requester and whoever actually resolved it) replaces the stale pending row here.
          setResolveError(res.error ?? "Could not resolve that request — a friend may have already answered it.");
          loadRequests();
          return;
        }
        setRequests((prev) =>
          (prev ?? []).map((r) =>
            r.id === requestId ? { ...r, status: decision, resolvedBy: selfUserId } : r
          )
        );
      })
      .catch((err) => {
        console.error("Failed to resolve unlock request", err);
        setResolveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResolvingId(null));
  }

  const isSessionActive = session !== null && NON_TERMINAL_STATES.has(session.state);
  const myRequestsForThisSession = (requests ?? []).filter(
    (r) => session && r.sessionId === session.id && r.requesterUserId === selfUserId
  );
  const pendingFromOthers = (requests ?? []).filter(
    (r) => r.status === "pending" && r.requesterUserId !== selfUserId
  );

  return (
    <div className="unlock-request-panel">
      <header className="unlock-request-panel__header">
        <h2>Unlock requests</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {selfError && <p role="alert">Couldn't verify sign-in: {selfError}.</p>}

      {isSessionActive && (
        <section className="unlock-request-panel__request">
          <h3>Request an unlock</h3>
          <p>Ask a friend in your group to unlock a site for the rest of this session.</p>
          {blockedHostnames.length > 0 && (
            <div className="unlock-request-panel__suggestions">
              {blockedHostnames.map((hostname) => (
                <button
                  key={hostname}
                  type="button"
                  onClick={() => setHostnameInput(hostname)}
                  disabled={createBusy}
                >
                  {hostname}
                </button>
              ))}
            </div>
          )}
          <label>
            Hostname
            <input
              type="text"
              value={hostnameInput}
              onChange={(e) => setHostnameInput(e.target.value)}
              placeholder="e.g. youtube.com"
              disabled={createBusy}
            />
          </label>
          <button
            type="button"
            onClick={() => handleCreateRequest(hostnameInput)}
            disabled={createBusy || !hostnameInput.trim()}
          >
            {createBusy ? "Requesting…" : "Request unlock"}
          </button>
          {createError && <p role="alert">Request not sent: {createError}</p>}

          {myRequestsForThisSession.length > 0 && (
            <ul className="unlock-request-panel__my-requests">
              {myRequestsForThisSession.map((r) => (
                <li key={r.id}>
                  {r.hostname} — {STATUS_LABEL[r.status]}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="unlock-request-panel__friends">
        <h3>Requests from friends</h3>
        {resolveError && <p role="alert">{resolveError}</p>}
        {pendingFromOthers.length === 0 && !loading && !error && (
          <p>No pending unlock requests from friends.</p>
        )}
        {pendingFromOthers.length > 0 && (
          <ul>
            {pendingFromOthers.map((r) => (
              <li key={r.id}>
                <span>
                  {r.requesterUserId} wants to unlock {r.hostname}
                </span>
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
      </section>

      <button type="button" onClick={loadRequests} disabled={loading}>
        {loading ? "Refreshing…" : "Refresh"}
      </button>
      {error && <p role="alert">Couldn't load unlock requests: {error}. Please try again.</p>}
    </div>
  );
}
