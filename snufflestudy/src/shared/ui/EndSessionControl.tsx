import { useState, type FormEvent } from "react";
import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

interface EndSessionControlProps {
  session: StudySession;
}

// Shared by PopupApp and SidePanelApp (mirrors the existing TimerRing/SessionStatusCard
// extraction precedent). For non-hard sessions, "End session" fires SESSION_END
// immediately, same as before this fix. For hard-restricted sessions it instead reveals
// an inline passcode prompt — mirroring `LockedPage.tsx`'s "submit a passcode, show an
// error on failure" shape (password input + submit, role="alert" error, disabled/loading
// state while in flight) — since the backend now rejects SESSION_END on a hard session
// with a configured HardBlockCredential unless a correct passcode is supplied.
export function EndSessionControl({ session }: EndSessionControlProps) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      // will swap this view out once the background clears the active session. Nothing
      // further to do here beyond leaving submitting=false in `finally` below.
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

  if (promptOpen) {
    return (
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
    );
  }

  return <button onClick={handleEndClick}>End session</button>;
}
