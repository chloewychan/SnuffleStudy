import { useState, type FormEvent } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

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
    </main>
  );
}
