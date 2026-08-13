import { useState } from "react";
import { getAnimationAsset, type WellnessState } from "./animationRegistry";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

interface SnufflesOverlayProps {
  classification: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";
  sessionId: string;
  hostname: string;
  reducedMotion: boolean;
}

function wellnessStateFor(classification: SnufflesOverlayProps["classification"]): WellnessState {
  return classification === "BLOCKED" ? "disappointed" : "focused";
}

export function SnufflesOverlay({
  classification,
  sessionId,
  hostname,
  reducedMotion,
}: SnufflesOverlayProps) {
  const [dismissed, setDismissed] = useState(false);
  const asset = getAnimationAsset("study", wellnessStateFor(classification));
  const imageSrc = reducedMotion ? asset.staticFrame : asset.frames[0];

  if (classification !== "BLOCKED" || dismissed) {
    return (
      <div className="snuffles-overlay snuffles-overlay--idle">
        <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      </div>
    );
  }

  function handleReturnToWork() {
    setDismissed(true);
    // document.referrer tells apart "reached this restricted site from another real page"
    // (a link click, form submit, etc. - there's real navigation history to go back to) from
    // "opened fresh" (new tab, typed URL, bookmark - referrer is empty, and history.back()
    // would silently do nothing). In the first case, navigate the same tab back; in the
    // second, closing the tab is the only way to actually return the user to their prior
    // context, since there's nothing in this tab's history to return to.
    if (document.referrer) {
      window.history.back();
    } else {
      sendMessage({ type: "RETURN_TO_WORK_CLOSE_TAB" }).catch((err) =>
        console.error("Failed to close tab", err)
      );
    }
  }

  function handleMarkStudyRelated() {
    // Fire-and-forget from the UI's perspective, but a rejected sendMessage must not
    // become an unhandled promise rejection and must not dismiss the warning (that
    // would leave UI state inconsistent with the backend never having recorded the
    // exemption). Mirrors PopupApp's .catch(console.error) precedent for the same
    // fire-and-forget-button-click defect class.
    sendMessage({ type: "MARK_SITE_STUDY_RELATED", payload: { sessionId, hostname } })
      .then(() => setDismissed(true))
      .catch((err) => console.error("Failed to mark site as study-related", err));
  }

  return (
    <div className="snuffles-overlay snuffles-overlay--warning" role="alert">
      <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      <p>That is not chemistry.</p>
      <div className="snuffles-overlay__actions">
        <button onClick={handleReturnToWork}>Return to work</button>
        <button onClick={handleMarkStudyRelated}>Mark this site as study-related</button>
      </div>
    </div>
  );
}
