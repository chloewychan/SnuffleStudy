import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { useRefreshAll } from "../refresh/RefreshRegistryContext";

// Minimal shape of AUTH_GET_SESSION's response this component needs - mirrors the same
// minimal AuthUser/AuthSession shape duplicated in AccountPage.tsx and FriendGroupPanel.tsx.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

interface HeaderProps {
  // Navigates within the side panel itself to Settings -> Account (where sign-in lives), rather
  // than out to the separate full-tab Options page. SidePanelApp.tsx wires this to its own
  // setActiveTab("settings") - the same activeTab state TabBar already switches on.
  onSignInClick: () => void;
}

export function Header({ onSignInClick }: HeaderProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  // v4.1 Task 2: replaces every panel's own Refresh button - this one re-runs every
  // currently-mounted panel's own fetch via the app-shell-level RefreshRegistryProvider.
  const refreshAll = useRefreshAll();

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
      <button type="button" className="sp-header__refresh-button" onClick={refreshAll}>
        Refresh
      </button>
      {loaded && !session && (
        <button type="button" className="sp-header__login-button" onClick={onSignInClick}>
          Log-In
        </button>
      )}
    </header>
  );
}
