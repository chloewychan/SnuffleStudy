import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

// Minimal shape of AUTH_GET_SESSION's response this component needs - mirrors the same
// minimal AuthUser/AuthSession shape duplicated in AccountPage.tsx and FriendGroupPanel.tsx.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

export function Header() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sendMessage<{ ok: boolean; session: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setSession(res.session);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="sp-header">
      <img
        className="sp-header__mascot"
        src={chrome.runtime.getURL("sidepanel/bunny-and-book.png")}
        alt=""
      />
      <h1 className="sp-header__title">SnuffleStudy</h1>
      {loaded && !session && (
        <button
          type="button"
          className="sp-header__login-button"
          onClick={() => {
            // Fix 6 (final-review fix wave): chrome.runtime.openOptionsPage() returns a Promise
            // that can reject (e.g. extension-context-invalidated) - this codebase's standing
            // convention is to never leave an async call triggered from a UI handler unhandled
            // (see ActiveSessionView.tsx/SessionSetupForm.tsx's sendMessage calls for the same
            // pattern). Promise.resolve(...) normalizes the case where a test mock's
            // openOptionsPage() returns undefined instead of a real Promise.
            void Promise.resolve(chrome.runtime.openOptionsPage()).catch((e) =>
              console.error("Failed to open options page", e)
            );
          }}
        >
          Log-In
        </button>
      )}
    </header>
  );
}
