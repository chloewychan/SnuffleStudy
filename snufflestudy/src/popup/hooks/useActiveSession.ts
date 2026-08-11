import { useEffect, useState } from "react";
import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

const ACTIVE_SESSION_KEY = "snufflestudy.activeSession";

export function useActiveSession() {
  const [session, setSession] = useState<StudySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await sendMessage<{ ok: boolean; session: StudySession | null }>({
          type: "SESSION_GET_ACTIVE",
        });
        if (!cancelled) {
          setSession(response.session);
          setError(null);
        }
      } catch (err) {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not
        // establish connection. Receiving end does not exist." during service-worker
        // startup races, or extension-context-invalidated. Surface it via `error`
        // instead of leaving an unhandled rejection and a permanently loading UI.
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    function onStorageChange(changes: Record<string, chrome.storage.StorageChange>) {
      if (ACTIVE_SESSION_KEY in changes) {
        setSession((changes[ACTIVE_SESSION_KEY].newValue as StudySession | undefined) ?? null);
      }
    }
    chrome.storage.onChanged.addListener(onStorageChange);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, []);

  return { session, loading, error };
}
