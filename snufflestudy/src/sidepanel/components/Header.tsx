import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { useRefreshAll, useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { ButtonIcon } from "./ui/ButtonIcon";
import { ButtonLarge } from "./ui/ButtonLarge";

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

// design-specs/frames/header-bar.json (component 170:1476). Chrome has no chrome.sidePanel.close()
// API - window.close() is the documented way for a side panel's own page to close itself.
function handleClose() {
  window.close();
}

export function Header({ onSignInClick }: HeaderProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  // v4.1 Task 2: replaces every panel's own Refresh button - this one re-runs every
  // currently-mounted panel's own fetch via the app-shell-level RefreshRegistryProvider.
  const refreshAll = useRefreshAll();

  // Registered with the refresh registry (not just called once on mount) so a sign-in/sign-out/
  // delete-account elsewhere in the panel (AccountPage.tsx, via useRefreshAllSafe()) updates the
  // Log-In button here too - Header stays mounted across a tab switch (it's outside the
  // activeTab-conditional branches in SidePanelApp.tsx), so without this its own session state
  // would otherwise only ever reflect whatever was true the moment the panel first opened.
  function loadSession() {
    sendMessage<{ ok: boolean; session: AuthSession | null; error?: string }>({
      type: "AUTH_GET_SESSION",
    })
      .then((res) => {
        if (res.ok) setSession(res.session);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }
  useRegisterRefresh(loadSession);

  useEffect(() => {
    loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header className="sp-header">
      <div className="sp-header__content">
        <div className="sp-header__buttons">
          <ButtonIcon icon="x" aria-label="Close side panel" onClick={handleClose} />
          <ButtonIcon icon="reload" aria-label="Refresh" onClick={refreshAll} />
          {loaded && !session && <ButtonLarge onClick={onSignInClick}>Log In</ButtonLarge>}
        </div>
        <h1 className="sp-header__title">SnuffleStudy</h1>
      </div>
      <img
        className="sp-header__mascot"
        src={chrome.runtime.getURL("sidepanel/bunny-and-book.png")}
        alt=""
      />
    </header>
  );
}
