import { useEffect, useRef, useState, type FormEvent } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";

// Minimal shape of what AUTH_GET_SESSION's response carries that this page actually needs -
// mirrors FriendGroupPanel.tsx's identical minimal AuthUser/AuthSession shapes.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

// friend_requests' status column is only 'pending' | 'approved' | 'denied' - there is no
// 'expired' status set server-side. A request that is actually expired but still marked
// 'approved' simply fails to claim instead of transitioning to a different status.
const STATUS_LABEL: Record<FriendRequest["status"], string> = {
  pending: "Waiting for your friend to respond…",
  approved: "Approved — unlocking…",
  denied: "Denied.",
};

export function LockedPage() {
  // Read from `document.location` rather than `window.location`: per spec these are
  // the same object in a real browser, but tests that mock navigation by reassigning
  // `window.location` (to intercept the `.href = ...` write below without triggering
  // an actual page load) leave `document.location` holding the real query string.
  const params = new URLSearchParams(document.location.search);
  const site = params.get("site") ?? "this site";
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Session id is needed to request a temporary passcode (FRIEND_REQUEST_CREATE below); the
  // permanent-passcode flow above needs no session id at all. Fetched once on mount, best-effort -
  // a failure here only disables the temp-passcode action, never the permanent-passcode flow above.
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Friend picker, backed by a single FRIENDS_LIST call. Friends are shown by human_name where
  // one exists (see useDisplayNames below), falling back to the raw user id otherwise.
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [selectedFriendId, setSelectedFriendId] = useState("");

  // Optional free-text explanation, next to the friend picker — gives the approving friend
  // something to judge beyond a bare hostname. 280 chars is long enough for a sentence or two
  // without turning into an essay field.
  const [requestMessage, setRequestMessage] = useState("");

  // Resolves each friend id to their human_name, falling back to the raw id when no profile/name
  // exists. See shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(friendIds ?? []);

  const [tempRequest, setTempRequest] = useState<FriendRequest | null>(null);
  const [tempBusy, setTempBusy] = useState(false);
  const [tempError, setTempError] = useState<string | null>(null);

  // No code to enter: once tempRequest.status is "approved", an effect below auto-claims it and
  // navigates on success. claimAttemptedRef makes that claim idempotent per request id (a Set,
  // not a single boolean, since a denied request can be re-asked, producing a new request id to
  // track independently).
  const claimAttemptedRef = useRef<Set<string>>(new Set());
  const [claimError, setClaimError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    sendMessage<{ ok: boolean; session?: { id: string } | null; error?: string }>({
      type: "SESSION_GET_ACTIVE",
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.session) setSessionId(res.session.id);
      })
      .catch((err) => {
        console.error("Failed to load the active session for the temp-passcode request", err);
      });

    sendMessage<{ ok: boolean; session?: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setFriendsError(res.error ?? "Could not verify your sign-in status.");
          return;
        }
        const userId = res.session?.user.id ?? null;
        setSelfUserId(userId);
        if (!userId) {
          setFriendIds([]);
          return;
        }

        sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({
          type: "FRIENDS_LIST",
        })
          .then((friendsRes) => {
            if (cancelled) return;
            if (!friendsRes.ok) {
              setFriendsError(friendsRes.error ?? "Could not load your friends.");
              return;
            }
            setFriendIds(friendsRes.friendIds ?? []);
          })
          .catch((err) => {
            console.error("Failed to load friends for the friend picker", err);
            if (!cancelled) setFriendsError(err instanceof Error ? err.message : String(err));
          });
      })
      .catch((err) => {
        console.error("Failed to load current user for the friend picker", err);
        if (!cancelled) setFriendsError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveFriendId = selectedFriendId || friendIds?.[0] || "";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await sendMessage<{ ok: boolean }>({
        type: "HARD_BLOCK_VERIFY_PASSCODE",
        payload: { passcode, hostname: site },
      });

      if (!response.ok) {
        setError("Incorrect passcode, or temporarily locked after repeated attempts.");
        return;
      }

      window.location.href = `https://${site}`;
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated. This page is the only thing standing between
      // the user and the site they're trying to unlock, so surface the failure via the
      // existing `error` state instead of leaving an unhandled rejection and an "Unlock"
      // button that silently never responds again.
      console.error("Failed to verify passcode", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleRequestTempPasscode() {
    if (!sessionId || !effectiveFriendId) return;
    setTempBusy(true);
    setTempError(null);
    // Trimmed, and omitted entirely when empty - an all-whitespace or untouched input must not
    // send a stray `message: ""`/`message: "   "` through to createRequest, which reads any
    // truthy `message` as "the requester provided one."
    const trimmedMessage = requestMessage.trim();
    sendMessage<{ ok: boolean; request?: FriendRequest; error?: string }>({
      type: "FRIEND_REQUEST_CREATE",
      payload: {
        kind: "site_temp_pass",
        sessionId,
        hostname: site,
        friendUserId: effectiveFriendId,
        ...(trimmedMessage ? { message: trimmedMessage } : {}),
      },
    })
      .then((res) => {
        if (!res.ok || !res.request) {
          setTempError(res.error ?? "Could not send that request.");
          return;
        }
        setTempRequest(res.request);
      })
      .catch((err) => {
        console.error("Failed to create temp passcode request", err);
        setTempError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setTempBusy(false));
  }

  function handleRefreshTempRequestStatus() {
    if (!tempRequest) return;
    setTempBusy(true);
    setTempError(null);
    sendMessage<{ ok: boolean; requests?: FriendRequest[]; error?: string }>({
      type: "FRIEND_REQUESTS_FETCH",
      payload: { sinceTimestamp: 0 },
    })
      .then((res) => {
        if (!res.ok || !res.requests) {
          setTempError(res.error ?? "Could not refresh the request status.");
          return;
        }
        const updated = res.requests.find((r) => r.id === tempRequest.id);
        if (updated) setTempRequest(updated);
      })
      .catch((err) => {
        console.error("Failed to refresh temp passcode request status", err);
        setTempError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setTempBusy(false));
  }

  // No code to enter: once a friend approves, this auto-claims the request instead of waiting
  // for the user to type anything. Runs whenever tempRequest's status is (or becomes)
  // "approved", guarded by claimAttemptedRef so it fires at most once per request id - both
  // handleRefreshTempRequestStatus's poll above and the background poll's own notification can
  // independently lead here, and re-renders must not refire an already-in-flight-or-done claim.
  // On success, navigates exactly like the permanent-passcode flow above; on failure, this
  // leaves claimError set for the inline error/retry UI below.
  useEffect(() => {
    if (!tempRequest || tempRequest.status !== "approved") return;
    if (claimAttemptedRef.current.has(tempRequest.id)) return;
    claimAttemptedRef.current.add(tempRequest.id);
    setClaimError(null);

    sendMessage<{ ok: boolean }>({
      type: "FRIEND_REQUEST_CLAIM_TEMP_PASS",
      payload: { requestId: tempRequest.id },
    })
      .then((res) => {
        if (!res.ok) {
          setClaimError("This pass couldn't be claimed — it may have expired. Ask again.");
          return;
        }
        // Same success navigation as the permanent-passcode flow above.
        window.location.href = `https://${site}`;
      })
      .catch((err) => {
        console.error("Failed to claim an approved temp passcode request", err);
        setClaimError(err instanceof Error ? err.message : String(err));
      });
  }, [tempRequest, site]);

  // Clears this request id from claimAttemptedRef and replaces tempRequest with a new object
  // (same fields, new reference) so the effect above's dependency check sees a change and re-fires
  // the claim - a plain in-place mutation wouldn't trigger a re-run.
  function handleRetryClaim() {
    if (!tempRequest) return;
    claimAttemptedRef.current.delete(tempRequest.id);
    setClaimError(null);
    setTempRequest({ ...tempRequest });
  }

  return (
    <main className="locked-page">
      <h1>{site} is hard-restricted for this session</h1>
      <p>Ask whoever holds the passcode for it.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "Checking…" : "Unlock"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}

      <section className="locked-page__temp-passcode">
        <h2>Or request a temporary passcode</h2>
        {friendsError && <p role="alert">Couldn't load your friends: {friendsError}.</p>}

        {!tempRequest && (
          <>
            {friendIds && friendIds.length > 0 && (
              <label>
                Ask
                <select
                  value={effectiveFriendId}
                  onChange={(e) => setSelectedFriendId(e.target.value)}
                  disabled={tempBusy}
                >
                  {friendIds.map((id) => (
                    <option key={id} value={id}>
                      {displayName(id)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {friendIds && friendIds.length === 0 && !friendsError && (
              <p>No friends available to ask yet - add a friend first.</p>
            )}
            <label>
              Why do you need this? (optional)
              <input
                type="text"
                value={requestMessage}
                onChange={(e) => setRequestMessage(e.target.value)}
                placeholder="Why do you need this? (optional)"
                maxLength={280}
                disabled={tempBusy}
              />
            </label>
            <button
              type="button"
              onClick={handleRequestTempPasscode}
              disabled={tempBusy || !sessionId || !effectiveFriendId}
            >
              {tempBusy ? "Requesting…" : "Request a temporary passcode"}
            </button>
            {tempError && <p role="alert">{tempError}</p>}
          </>
        )}

        {tempRequest && (
          <div className="locked-page__temp-request-status">
            <p>{STATUS_LABEL[tempRequest.status]}</p>
            {tempRequest.status === "pending" && (
              <button type="button" onClick={handleRefreshTempRequestStatus} disabled={tempBusy}>
                {tempBusy ? "Checking…" : "Check status"}
              </button>
            )}

            {tempRequest.status === "approved" && claimError && (
              <div>
                <p role="alert">{claimError}</p>
                <button type="button" onClick={handleRetryClaim}>
                  Retry
                </button>
              </div>
            )}

            {tempRequest.status === "denied" && (
              <button
                type="button"
                onClick={() => {
                  setTempRequest(null);
                  setTempError(null);
                }}
              >
                Ask again
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
