import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { useRefreshAll } from "../refresh/RefreshRegistryContext";
import styles from "../styles/frontend-backup/components/layout/HeaderBar.module.css";

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
    <section className={styles.headerBar}>
      <div className={styles.headerControls}>
        <div className={styles.frame}>
          {/* HeaderBar.tsx's "close" icon has no current equivalent action anywhere in this
              app (v4.2 Task 2, Header + TabBar) - left non-interactive rather than inventing
              one, per the plan's explicit instruction. */}
          <div className={styles.buttonIcon}>
            <div className={styles.iconShape} />
            <img
              className={styles.vectorIcon}
              alt=""
              src={chrome.runtime.getURL("sidepanel/assets/icon-close.svg")}
            />
          </div>
          {/* Re-skinned Refresh button (still the same v4.1 Task 2 button): re-runs every
              currently-mounted panel's own fetch via the app-shell-level
              RefreshRegistryProvider. */}
          <button
            type="button"
            className={`${styles.buttonIcon} ${styles.buttonIconReset}`}
            onClick={refreshAll}
            aria-label="Refresh"
          >
            <div className={styles.iconShape} />
            <img
              className={styles.vectorIcon2}
              alt=""
              src={chrome.runtime.getURL("sidepanel/assets/icon-refresh.svg")}
            />
          </button>
          {loaded && !session && (
            <button type="button" className={styles.buttonLarge} onClick={onSignInClick}>
              <h3 className={styles.button}>Log In</h3>
            </button>
          )}
        </div>
        <h1 className={styles.snufflestudy}>SnuffleStudy</h1>
      </div>
      <img
        className={styles.bunnyAndBook}
        loading="lazy"
        alt=""
        src={chrome.runtime.getURL("sidepanel/assets/Bunny-and-Book@2x.png")}
      />
    </section>
  );
}
