import { defineContentScript } from "wxt/utils/define-content-script";
import { mount } from "./overlay/overlayHost";
import { currentHostname } from "./siteContext";
import { sendMessage } from "../infrastructure/messaging/extensionMessenger";
import type { StudySession } from "../domain/session/sessionTypes";

export default defineContentScript({
  // Registered dynamically (see src/background/contentScriptRegistration.ts) only after the
  // user grants the "detailed" tracking tier — per Decision #2, this script is never injected
  // via a static `matches: ["<all_urls>"]` entry, which would force the broad host-permission
  // prompt on every install regardless of tracking tier.
  //
  // `matches: []` alone is not enough: WXT would still emit a static `content_scripts` entry
  // in the manifest with an empty `matches` array, which fails Chrome's manifest schema
  // validation (`must NOT have fewer than 1 items`, confirmed via `web-ext lint` against the
  // built output) — i.e. the extension would fail to load at all. `registration: "runtime"`
  // is WXT's documented mechanism for a dynamic-only content script: it omits the entry from
  // `content_scripts` entirely (and would add `matches` to `host_permissions` if non-empty,
  // which it isn't here) instead of emitting an inert-but-invalid static entry.
  matches: [],
  registration: "runtime",
  async main() {
    // Content scripts run in the page context: an unhandled rejection here would spam the
    // user's browser console on every page load if the background service worker is asleep
    // or a message fails to round-trip — worse than the popup/options cases (which are only
    // open when the user opens them). Any failure below should just silently skip mounting
    // the overlay rather than throw. (Standing project policy: fix bare-async-call-with-no-
    // error-handling defects proactively rather than leaving them for a review round.)
    try {
      const activeResponse = await sendMessage<{ ok: boolean; session: StudySession | null }>({
        type: "SESSION_GET_ACTIVE",
      });

      if (!activeResponse.session || activeResponse.session.state !== "FOCUSING") return;

      const statusResponse = await sendMessage<{ ok: boolean; classification: string }>({
        type: "SITE_STATUS_REQUEST",
        payload: { hostname: currentHostname() },
      });

      mount({
        classification: statusResponse.classification as "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE",
        sessionId: activeResponse.session.id,
      });
    } catch {
      // Silently no-op — see rationale above. Not logged: this runs on every page load, and
      // console noise here would be user-visible (unlike a swallowed error in the popup).
    }
  },
});
