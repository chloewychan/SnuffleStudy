import { useEffect, useState } from "react";
import type { StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

const ACTIVE_SESSION_KEY = "snufflestudy.activeSession";

export function useActiveSession() {
  const [session, setSession] = useState<StudySession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const response = await sendMessage<{ ok: boolean; session: StudySession | null }>({
        type: "SESSION_GET_ACTIVE",
      });
      if (!cancelled) {
        setSession(response.session);
        setLoading(false);
      }
    }

    load();

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

  return { session, loading };
}
