import { useEffect, useState, type FormEvent } from "react";
import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import { useDisplayNames } from "./useDisplayNames";
import { ButtonLarge } from "../../sidepanel/components/ui/ButtonLarge";

interface EndSessionControlProps {
  session: StudySession;
}

// v3.3 Task 12: mirrors LockedPage.tsx's STATUS_LABEL const for its temp-passcode status block.
const END_REQUEST_STATUS_LABEL: Record<FriendRequest["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
};

// design-specs/frames/page-study-session.json's button-options ("End Session"). Only
// ActiveSessionView.tsx mounts this now (the standalone browser-action popup entrypoint this
// comment used to also mention was removed from the manifest before this task). For non-hard
// sessions, "End session" fires SESSION_END
// immediately, same as before this fix. For hard-restricted sessions it instead reveals
// an inline passcode prompt — mirroring `LockedPage.tsx`'s "submit a passcode, show an
// error on failure" shape (password input + submit, role="alert" error, disabled/loading
// state while in flight) — since the backend now rejects SESSION_END on a hard session
// with a configured HardBlockCredential unless a correct passcode is supplied.
//
// v3.3 Task 12: alongside that unchanged passcode form, `promptOpen` now also offers "Request a
// temporary pass from a friend" — mirrors LockedPage.tsx's temp-passcode request/status pattern
// (v3.4 Task 3: FRIEND_REQUEST_CREATE("session_end", ...), then poll via FRIEND_REQUESTS_FETCH
// for "Check status", then once approved, an "End session now" button). Deliberately does NOT
// auto-claim the way LockedPage.tsx's temp-passcode flow does (per the Global Constraints note:
// ending a session is disruptive, so an approved session-end request is never auto-applied - not
// even by this component reacting to its own poll result on its own; a human still has to click
// "End session now").
//
// v3.4 Task 3: this form gained a friend picker + optional message field, matching
// LockedPage.tsx's exact pattern - previously a bare button with no target (any friend sharing a
// group with the requester could resolve it, mirroring unlock_requests' group-wide shape); now
// the requester picks a specific friend, same as site_temp_pass requests already did.
export function EndSessionControl({ session }: EndSessionControlProps) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [endRequest, setEndRequest] = useState<FriendRequest | null>(null);
  const [endRequestBusy, setEndRequestBusy] = useState(false);
  const [endRequestError, setEndRequestError] = useState<string | null>(null);

  // v3.4 Task 3: friend picker state, mirroring LockedPage.tsx's friendIds/selectedFriendId/
  // requestMessage exactly - one FRIENDS_LIST call, same friend-picker pattern
  // RequestUnlockForm.tsx/LockedPage.tsx already use.
  const [friendIds, setFriendIds] = useState<string[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [selectedFriendId, setSelectedFriendId] = useState("");
  const [requestMessage, setRequestMessage] = useState("");

  // v3.3 Task 8: resolves each friend id to their human_name (falling back to the raw id, same
  // as LockedPage.tsx's identical picker) - see shared/ui/useDisplayNames.ts.
  const displayName = useDisplayNames(friendIds ?? []);

  useEffect(() => {
    if (!promptOpen) return;
    let cancelled = false;
    sendMessage<{ ok: boolean; friendIds?: string[]; error?: string }>({ type: "FRIENDS_LIST" })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setFriendsError(res.error ?? "Could not load your friends.");
          return;
        }
        setFriendIds(res.friendIds ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load friends for the session-end friend picker", err);
        setFriendsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [promptOpen]);

  const effectiveFriendId = selectedFriendId || friendIds?.[0] || "";

  function endImmediately() {
    sendMessage({ type: "SESSION_END", payload: { sessionId: session.id } }).catch((err) =>
      console.error("Failed to end session", err)
    );
  }

  function handleEndClick() {
    if (session.restrictionMode === "hard") {
      setPromptOpen(true);
      return;
    }
    endImmediately();
  }

  function handleCancel() {
    setPromptOpen(false);
    setPasscode("");
    setError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: "SESSION_END",
        payload: { sessionId: session.id, passcode },
      });

      if (!response.ok) {
        setError(response.error ?? "Incorrect passcode, or temporarily locked after repeated attempts.");
        return;
      }
      // Success: the active-session subscription (useActiveSession's storage listener)
      // will swap this view out for AbandonedScreen once the background updates the active
      // session to ABANDONED (kept active rather than cleared - see messageRouter.ts's
      // SESSION_END handler - so the user gets an acknowledgment screen, mirroring the
      // COMPLETED flow). Nothing further to do here beyond leaving submitting=false in
      // `finally` below.
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated. Surface it via `error` instead of leaving an
      // unhandled rejection and a submit button that silently never responds again.
      console.error("Failed to end session", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // v3.3 Task 12: requester side - "Request a temporary pass from a friend". Mirrors
  // LockedPage.tsx's handleRequestTempPasscode shape (sendMessage, store the created request in
  // state on success, surface an inline error otherwise). v3.4 Task 3: now sends
  // FRIEND_REQUEST_CREATE("session_end", ...) with the picked friendUserId/optional message,
  // trimmed and omitted entirely when empty - same convention LockedPage.tsx's
  // handleRequestTempPasscode already established.
  function handleRequestPass() {
    setEndRequestBusy(true);
    setEndRequestError(null);
    const trimmedMessage = requestMessage.trim();
    sendMessage<{ ok: boolean; request?: FriendRequest; error?: string }>({
      type: "FRIEND_REQUEST_CREATE",
      payload: {
        kind: "session_end",
        sessionId: session.id,
        friendUserId: effectiveFriendId,
        ...(trimmedMessage ? { message: trimmedMessage } : {}),
      },
    })
      .then((res) => {
        if (!res.ok || !res.request) {
          setEndRequestError(res.error ?? "Could not send that request.");
          return;
        }
        setEndRequest(res.request);
      })
      .catch((err) => {
        console.error("Failed to create session-end request", err);
        setEndRequestError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setEndRequestBusy(false));
  }

  // v3.3 Task 12: mirrors LockedPage.tsx's handleRefreshTempRequestStatus shape - a fresh
  // FRIEND_REQUESTS_FETCH, then find this request by id and replace local state with its
  // current (possibly still-pending) status. sinceTimestamp: 0 mirrors LockedPage.tsx's own
  // "check on one specific request by id" usage of this fetch, not a real lookback window.
  function handleCheckStatus() {
    if (!endRequest) return;
    setEndRequestBusy(true);
    setEndRequestError(null);
    sendMessage<{ ok: boolean; requests?: FriendRequest[]; error?: string }>({
      type: "FRIEND_REQUESTS_FETCH",
      payload: { sinceTimestamp: 0 },
    })
      .then((res) => {
        if (!res.ok || !res.requests) {
          setEndRequestError(res.error ?? "Could not refresh the request status.");
          return;
        }
        const updated = res.requests.find((r) => r.id === endRequest.id);
        if (updated) setEndRequest(updated);
      })
      .catch((err) => {
        console.error("Failed to refresh session-end request status", err);
        setEndRequestError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setEndRequestBusy(false));
  }

  // v3.3 Task 12: once endRequest.status === "approved", ends the session using the approved
  // pass instead of the permanent passcode - same success/failure handling handleSubmit above
  // already has for the passcode path (the active-session subscription swaps this view out on
  // success; a failure is surfaced inline rather than left as an unhandled rejection).
  // Deliberately a button click, not an effect that fires automatically the moment endRequest
  // becomes approved (unlike LockedPage.tsx's temp-passcode auto-claim) - per the Global
  // Constraints note, ending a session is disruptive, so it always waits for the user to click
  // this themselves.
  async function handleEndWithPass() {
    if (!endRequest) return;
    setEndRequestError(null);
    setEndRequestBusy(true);

    try {
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: "SESSION_END",
        payload: { sessionId: session.id, endRequestId: endRequest.id },
      });

      if (!response.ok) {
        setEndRequestError(
          response.error ?? "That temporary pass isn't valid for this session, or hasn't been approved yet."
        );
        return;
      }
      // Success: same active-session-subscription swap-out as handleSubmit's success path above.
    } catch (err) {
      console.error("Failed to end session with an approved temporary pass", err);
      setEndRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setEndRequestBusy(false);
    }
  }

  if (promptOpen) {
    return (
      <div className="end-session-control__prompt-wrapper">
        <form onSubmit={handleSubmit} className="end-session-control__prompt">
          <label htmlFor="end-session-passcode">Enter the passcode to end this hard-restricted session</label>
          <input
            id="end-session-passcode"
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Passcode"
          />
          <button type="submit" disabled={submitting}>
            {submitting ? "Checking…" : "Confirm end session"}
          </button>
          <button type="button" onClick={handleCancel} disabled={submitting}>
            Cancel
          </button>
          {error && <p role="alert">{error}</p>}
        </form>

        {/* v3.3 Task 12: alongside (never instead of) the passcode form above - a friend-approved
            temporary pass to end this session early. */}
        <div className="end-session-control__temp-pass">
          <h3>Or request a temporary pass</h3>

          {!endRequest && (
            <>
              {friendsError && <p role="alert">Couldn't load your friends: {friendsError}.</p>}
              {friendIds && friendIds.length > 0 && (
                <label>
                  Ask
                  <select
                    value={effectiveFriendId}
                    onChange={(e) => setSelectedFriendId(e.target.value)}
                    disabled={endRequestBusy}
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
                  disabled={endRequestBusy}
                />
              </label>
              <button
                type="button"
                onClick={handleRequestPass}
                disabled={endRequestBusy || !effectiveFriendId}
              >
                {endRequestBusy ? "Requesting…" : "Request a temporary pass from a friend"}
              </button>
              {endRequestError && <p role="alert">{endRequestError}</p>}
            </>
          )}

          {endRequest && (
            <div className="end-session-control__temp-pass-status">
              <p>{END_REQUEST_STATUS_LABEL[endRequest.status]}</p>

              {endRequest.status === "pending" && (
                <button type="button" onClick={handleCheckStatus} disabled={endRequestBusy}>
                  {endRequestBusy ? "Checking…" : "Check status"}
                </button>
              )}

              {endRequest.status === "approved" && (
                <button type="button" onClick={handleEndWithPass} disabled={endRequestBusy}>
                  {endRequestBusy ? "Ending…" : "End session now"}
                </button>
              )}

              {endRequest.status === "denied" && (
                <button
                  type="button"
                  onClick={() => {
                    setEndRequest(null);
                    setEndRequestError(null);
                  }}
                >
                  Ask again
                </button>
              )}

              {endRequestError && <p role="alert">{endRequestError}</p>}
            </div>
          )}
        </div>
      </div>
    );
  }

  return <ButtonLarge onClick={handleEndClick}>End Session</ButtonLarge>;
}
