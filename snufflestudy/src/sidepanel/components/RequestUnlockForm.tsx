import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import type { StudySession, SessionEvent } from "../../domain/session/sessionTypes";
import ButtonLarge from "../ui/ButtonLarge";
import TextInput from "../ui/TextInput";
import TextSmall from "../ui/TextSmall";
import styles from "./RequestUnlockForm.module.css";

interface RequestUnlockFormProps {
  // Non-null, unlike UnlockRequestPanel.tsx's old `session: StudySession | null` - this
  // component is only ever rendered when a session exists (Decision 5,
  // docs/implementation_plans/V3.4_Implementation_Plan.md): SidePanelApp.tsx's active-session
  // view composes this alongside ActiveSessionView; there is no other mount point (the old
  // `session={null}` usage - suppressing this section entirely when no session exists - is
  // simply not applicable anymore, since this component no longer has an approver-side section
  // to fall back to rendering).
  session: StudySession;
}

const STATUS_LABEL: Record<FriendRequest["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
};

// Mirrors FriendGroupPanel.tsx's identical lookback window/rationale - a point-in-time view of
// recent activity, not itself the delivery mechanism (that's alarmHandlers.ts's friend-poll
// alarm, which tracks its own separate "last checked" cursor via friendPollState.ts's
// getLastFriendRequestPollAt/setLastFriendRequestPollAt for chrome.notifications toasts).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

const NON_TERMINAL_STATES = new Set(["FOCUSING", "PAUSED", "BREAK"]);

// Per v2 Task 8's original brief (carried forward verbatim - this section's logic is unchanged
// by this task, only its home): SESSION_LIST_EVENTS (v1, already exists) already records a
// hostname on every DISTRACTION_ATTEMPT event for the current session - deriving distinct
// hostnames from that is cheap (one existing message, no new backend work) and used as quick-fill
// buttons below, alongside (not instead of) the manual text field.
function distinctBlockedHostnames(events: SessionEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type === "DISTRACTION_ATTEMPT" && event.hostname) {
      seen.add(event.hostname);
    }
  }
  return [...seen];
}

// v4.2 Task 7 (Decision 5): rebuilt fresh from the new design system's own primitives -
// frontend-backup has no page/component corresponding to this form at all (see this file's own
// CSS module header comment), so unlike every other v4.2 task this isn't a JSX transplant. Every
// piece of state, every handler, and every sendMessage() call below is byte-for-byte unchanged
// from the pre-v4.2 version - only the JSX return(...) block changed, composed from ButtonLarge
// (the suggestion chips + "Request unlock"/"Refresh" actions), TextInput (the hostname field), and
// this file's own RequestUnlockForm.module.css (mirroring ActiveSession.tsx's card/section/heading
// conventions - see the v4.2 Task 7 report for the full layout rationale).
export function RequestUnlockForm({ session }: RequestUnlockFormProps) {
  const [selfUserId, setSelfUserId] = useState<string | null>(null);

  const [requests, setRequests] = useState<FriendRequest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [blockedHostnames, setBlockedHostnames] = useState<string[]>([]);

  const [hostnameInput, setHostnameInput] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadSelf() {
    sendMessage<{ ok: boolean; session?: { user: { id: string } } | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (res.ok) setSelfUserId(res.session?.user.id ?? null);
      })
      .catch((err) => {
        console.error("Failed to load current user for the unlock-request form", err);
      });
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
    sendMessage<{ ok: boolean; events?: SessionEvent[]; error?: string }>({
      type: "SESSION_LIST_EVENTS",
      payload: { sessionId: session.id },
    })
      .then((res) => {
        if (!res.ok || !res.events) return;
        setBlockedHostnames(distinctBlockedHostnames(res.events));
      })
      .catch((err) => {
        // Purely a UI convenience (quick-fill suggestions) - never block the rest of the form on
        // this failing.
        console.error("Failed to load blocked-site suggestions", err);
      });
  }

  // Re-runs when the active session changes - session.id is a deliberate, narrow dependency (not
  // every prop this effect touches), since loadBlockedHostnames is the only one of the three that
  // actually varies with the session; loadSelf/loadRequests don't depend on it but are cheap/
  // idempotent to re-run.
  useEffect(() => {
    loadSelf();
    loadRequests();
    loadBlockedHostnames();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above.
  }, [session.id]);

  function handleCreateRequest(hostname: string) {
    const trimmed = hostname.trim();
    if (!trimmed) return;
    setCreateBusy(true);
    setCreateError(null);
    sendMessage<{ ok: boolean; request?: FriendRequest; error?: string }>({
      type: "FRIEND_REQUEST_CREATE",
      payload: { kind: "site_unlock", sessionId: session.id, hostname: trimmed },
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

  const isSessionActive = NON_TERMINAL_STATES.has(session.state);
  const myRequestsForThisSession = (requests ?? []).filter(
    (r) => r.kind === "site_unlock" && r.sessionId === session.id && r.requesterUserId === selfUserId
  );

  if (!isSessionActive) return null;

  return (
    <section className={styles.requestUnlockForm}>
      <h2 className={styles.heading}>Request an unlock</h2>
      <p className={styles.description}>
        Ask a friend to unlock a site for the rest of this session.
      </p>

      {blockedHostnames.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.subheading}>Recently Blocked</h3>
          <ul className={styles.suggestionList}>
            {blockedHostnames.map((hostname) => (
              <li key={hostname} className={styles.suggestionChip}>
                <ButtonLarge
                  button={hostname}
                  onClick={() => setHostnameInput(hostname)}
                  disabled={createBusy}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.hostnameField}>
          <label className={styles.label} htmlFor="unlock-request-hostname">
            Hostname
          </label>
          <TextInput
            id="unlock-request-hostname"
            entryFieldType="text"
            value={hostnameInput}
            onChange={(e) => setHostnameInput(e.target.value)}
            placeholder="e.g. youtube.com"
            disabled={createBusy}
          />
        </div>
        <ButtonLarge
          button={createBusy ? "Requesting…" : "Request unlock"}
          onClick={() => handleCreateRequest(hostnameInput)}
          disabled={createBusy || !hostnameInput.trim()}
        />
        {createError && <p role="alert">Request not sent: {createError}</p>}
      </div>

      {myRequestsForThisSession.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.subheading}>Your Requests This Session</h3>
          <ul className={styles.requestList}>
            {myRequestsForThisSession.map((r) => (
              <li key={r.id}>
                <TextSmall textbox={`${r.hostname} — ${STATUS_LABEL[r.status]}`} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p role="alert">Couldn't load your unlock requests: {error}. Please try again.</p>}
      <ButtonLarge
        button={loading ? "Refreshing…" : "Refresh"}
        onClick={loadRequests}
        disabled={loading}
      />
    </section>
  );
}
