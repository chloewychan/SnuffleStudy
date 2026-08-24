import { useEffect, useRef, useState, type FormEvent } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { TempPasscodeRequest } from "../../domain/accountability/tempPasscodeRequest";
import type { GroupMembership } from "../../infrastructure/backend/friendGroupApi";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";

// Minimal shape of what AUTH_GET_SESSION's response carries that this page actually needs -
// mirrors FriendGroupPanel.tsx's identical minimal AuthUser/AuthSession shapes.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

const STATUS_LABEL: Record<TempPasscodeRequest["status"], string> = {
  pending: "Waiting for your friend to respond…",
  approved: "Approved — unlocking…",
  denied: "Denied.",
  expired: "This request has expired.",
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

  // v2 Task 12: "request a temporary passcode" action, alongside the existing permanent-passcode
  // entry above. sessionId is needed for TEMP_PASSCODE_CREATE but this page never otherwise
  // fetches the active session (HARD_BLOCK_VERIFY_PASSCODE above needs no sessionId at all), so
  // it's fetched once on mount, best-effort - a failure here only disables the temp-passcode
  // action, never the existing permanent-passcode flow above.
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Friend picker - same GROUP_LIST_MINE -> GROUP_LIST_MEMBERS pattern FriendGroupPanel.tsx/
  // UnlockRequestPanel.tsx already use. v3.3 Task 8: friends are now shown by human_name where
  // one exists (useDisplayNames.ts below), falling back to the raw user id exactly like before
  // this task for anyone with no profile/name set.
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [selectedFriendId, setSelectedFriendId] = useState("");

  // v3.3 Task 11: optional free-text explanation, next to the friend picker - gives the
  // approving friend something to judge beyond a bare hostname. maxLength 280 is a judgment call
  // (not from the plan) - long enough for a real sentence or two of context, short enough to stay
  // a one-line-ish aside rather than turn into an essay field; matches the "no length constraint
  // beyond what the UI reasonably enforces" latitude the plan's Deliverables line explicitly
  // leaves to this task.
  const [requestMessage, setRequestMessage] = useState("");

  // v3.3 Task 8: resolves each friend id to their human_name (falling back to the raw id, same as
  // before this task, when no profile/name exists) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(friendIds ?? []);

  const [tempRequest, setTempRequest] = useState<TempPasscodeRequest | null>(null);
  const [tempBusy, setTempBusy] = useState(false);
  const [tempError, setTempError] = useState<string | null>(null);

  // v3.3 Task 10: no code to enter anymore - once tempRequest.status is "approved", an effect
  // below auto-claims it (TEMP_PASSCODE_CLAIM_APPROVAL) and navigates on success. claimAttemptedRef
  // makes that claim idempotent per request id (a Set, not a single boolean, since a denied/expired
  // request can be re-asked, producing a new request id to track independently).
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

        sendMessage<{ ok: boolean; memberships?: GroupMembership[]; error?: string }>({
          type: "GROUP_LIST_MINE",
        })
          .then((groupsRes) => {
            if (cancelled) return;
            if (!groupsRes.ok) {
              setFriendsError(groupsRes.error ?? "Could not load your friends.");
              return;
            }
            const memberships = groupsRes.memberships ?? [];
            if (memberships.length === 0) {
              setFriendIds([]);
              return;
            }
            Promise.all(
              memberships.map((m) =>
                sendMessage<{ ok: boolean; members?: GroupMembership[]; error?: string }>({
                  type: "GROUP_LIST_MEMBERS",
                  payload: { groupId: m.groupId },
                })
              )
            )
              .then((memberResponses) => {
                if (cancelled) return;
                const ids = new Set<string>();
                for (const memberRes of memberResponses) {
                  if (!memberRes.ok || !memberRes.members) continue;
                  for (const member of memberRes.members) {
                    if (member.userId !== userId) ids.add(member.userId);
                  }
                }
                setFriendIds([...ids]);
              })
              .catch((err) => {
                console.error("Failed to load group members for the friend picker", err);
                if (!cancelled) setFriendsError(err instanceof Error ? err.message : String(err));
              });
          })
          .catch((err) => {
            console.error("Failed to load groups for the friend picker", err);
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
    // v3.3 Task 11: trimmed, and omitted entirely when empty - an all-whitespace or untouched
    // input must not send a stray `message: ""`/`message: "   "` through to createRequest, which
    // reads any truthy `message` (see tempPasscodeApi.ts) as "the requester provided one."
    const trimmedMessage = requestMessage.trim();
    sendMessage<{ ok: boolean; request?: TempPasscodeRequest; error?: string }>({
      type: "TEMP_PASSCODE_CREATE",
      payload: {
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
    sendMessage<{ ok: boolean; requests?: TempPasscodeRequest[]; error?: string }>({
      type: "TEMP_PASSCODE_REQUESTS_FETCH",
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

  // v3.3 Task 10: no code to enter anymore - once a friend approves, this auto-claims the request
  // (TEMP_PASSCODE_CLAIM_APPROVAL) instead of waiting for the user to type anything. Runs whenever
  // tempRequest's status is (or becomes) "approved", guarded by claimAttemptedRef so it fires at
  // most once per request id - both handleRefreshTempRequestStatus's poll above and the background
  // poll's own notification (alarmHandlers.ts) can independently lead here, and re-renders must
  // not refire an already-in-flight-or-done claim. On success, navigates exactly like the
  // permanent-passcode flow above; on failure, this leaves claimError set for the inline
  // error/retry UI below.
  useEffect(() => {
    if (!tempRequest || tempRequest.status !== "approved") return;
    if (claimAttemptedRef.current.has(tempRequest.id)) return;
    claimAttemptedRef.current.add(tempRequest.id);
    setClaimError(null);

    sendMessage<{ ok: boolean }>({
      type: "TEMP_PASSCODE_CLAIM_APPROVAL",
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

            {(tempRequest.status === "denied" || tempRequest.status === "expired") && (
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
