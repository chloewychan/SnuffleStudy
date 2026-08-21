import { useEffect, useRef, useState } from "react";
import { getAnimationAsset, type WellnessState } from "./animationRegistry";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { pickWarningMessage } from "../../domain/pressure/pressureEngine";
import { generateCoachingMessage } from "../../infrastructure/backend/coachingApi";
import type { StudySession } from "../../domain/session/sessionTypes";

interface SnufflesOverlayProps {
  classification: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";
  sessionId: string;
  hostname: string;
  reducedMotion: boolean;
}

// v1's SnufflesOverlay hardcoded this literal string for every BLOCKED render regardless of the
// active session's pressure profile - v2 Task 11 replaces that with pickWarningMessage() (a real
// message from the active profile's pool), swapped in the instant SESSION_GET_ACTIVE resolves
// (near-instant - a local background message round trip, not a network call). This generic line
// is now reserved for the genuinely degraded case: SESSION_GET_ACTIVE itself fails or returns no
// session, so there is no pressure profile to pick a voiced line from at all. Per this task's
// brief ("fall back to a generic message, don't block the warning UI on it"), never blocking the
// warning UI on that fetch is the requirement - this string is what's shown while/if that fetch
// hasn't produced a real profile-specific message yet.
const GENERIC_FALLBACK_MESSAGE = "You're supposed to be studying right now.";

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
  const [message, setMessage] = useState(GENERIC_FALLBACK_MESSAGE);
  const asset = getAnimationAsset("study", wellnessStateFor(classification));
  const imageSrc = reducedMotion ? asset.staticFrame : asset.frames[0];

  // Mirrors `dismissed` state but readable synchronously inside the async effect below without
  // becoming a stale closure over the render that started it - a plain `dismissed` read captured
  // at effect-creation time would never see a dismissal that happens later, during the awaits.
  // Set alongside every setDismissed(true) call (see markDismissed below), so a coaching-message
  // response that arrives after the user has already dismissed the warning is discarded instead
  // of calling setState on a component the user no longer looks at - no flash of new warning text
  // after dismissal (the warning paragraph isn't even rendered once dismissed, but skipping the
  // setState entirely is the more defensive fix). The unmount case (navigating away entirely) is
  // covered separately by the effect's own `cancelled` closure variable below, the standard React
  // pattern for avoiding "setState on an unmounted component" - dismissedRef and `cancelled` are
  // deliberately two different flags for two different lifetimes (survives remounts vs. this one
  // effect run).
  const dismissedRef = useRef(false);

  function markDismissed() {
    dismissedRef.current = true;
    setDismissed(true);
  }

  // Fetches the active session (best-effort - SESSION_GET_ACTIVE, the same message
  // content/index.ts already sends, per messageRouter.ts:236-238) so this overlay can render a
  // message from the session's actual PressureProfile instead of a single hardcoded literal.
  // Genuine wiring of two pre-existing-but-dead pieces, not new domain logic: pickWarningMessage()
  // (src/domain/pressure/pressureEngine.ts) already existed with zero call sites anywhere in the
  // app, and this SESSION_GET_ACTIVE round trip is the exact mechanism content/index.ts already
  // uses to decide whether to mount the overlay at all.
  //
  // Sequencing matches this task's brief precisely: render the static pickWarningMessage() line
  // the instant the session is known (zero perceived latency - this is a local background
  // message round trip, not a network call, so it resolves far faster than any human notices),
  // never blocking the warning UI on it; only THEN kick off generateCoachingMessage() in the
  // background and swap its result in if it arrives before the user dismisses the warning.
  useEffect(() => {
    if (classification !== "BLOCKED") return;
    let cancelled = false;

    (async () => {
      try {
        const response = await sendMessage<{ ok: boolean; session: StudySession | null }>({
          type: "SESSION_GET_ACTIVE",
        });
        if (cancelled || dismissedRef.current) return;

        const session = response.session;
        if (!session) return; // Best-effort - no session to pick a voiced message from; keep the generic fallback.

        setMessage(pickWarningMessage(session.pressureProfileId, session.interventionLevel));

        const generated = await generateCoachingMessage({
          pressureProfileId: session.pressureProfileId,
          goal: session.goal,
          hostname,
          interventionLevel: session.interventionLevel,
        });
        if (cancelled || dismissedRef.current) return;
        setMessage(generated);
      } catch (err) {
        // SESSION_GET_ACTIVE itself failed (e.g. background service worker asleep) - best-effort,
        // never block or break the warning UI on it. Leaves the generic fallback message in place.
        console.error("Failed to fetch active session for coaching message", err);
      }
    })();

    return () => {
      cancelled = true;
    };
    // sessionId intentionally excluded from the dependency list - the fetched session's own id is
    // what this effect actually reads (via response.session), not the sessionId prop.
  }, [classification, hostname]);

  if (classification !== "BLOCKED" || dismissed) {
    return (
      <div className="snuffles-overlay snuffles-overlay--idle">
        <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      </div>
    );
  }

  function handleReturnToWork() {
    markDismissed();
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
      .then(() => markDismissed())
      .catch((err) => console.error("Failed to mark site as study-related", err));
  }

  return (
    <div className="snuffles-overlay snuffles-overlay--warning" role="alert">
      <img src={imageSrc} alt="Snuffles" width={96} height={96} />
      <p>{message}</p>
      <div className="snuffles-overlay__actions">
        <button onClick={handleReturnToWork}>Return to work</button>
        <button onClick={handleMarkStudyRelated}>Mark this site as study-related</button>
      </div>
    </div>
  );
}
