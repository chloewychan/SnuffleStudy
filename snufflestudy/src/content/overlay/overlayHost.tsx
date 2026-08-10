import { createRoot } from "react-dom/client";
import { SnufflesOverlay } from "./SnufflesOverlay";
import { currentHostname } from "../siteContext";
// The overlay's CSS must be injected as plain text into a Shadow Root (see mount() below),
// not auto-injected into the host page's <head> the way Vite normally handles CSS imports.
// It's a plain template-literal string export rather than a `.css` file import - see
// overlayStyles.ts for why both `import "./overlay.css"` and `?inline`/`?raw` CSS-file
// import queries were rejected (build crash, and a silent empty-string mismatch between the
// real build and the Vitest test environment, respectively).
import { overlayStyles } from "./overlayStyles";

interface MountOptions {
  classification: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";
  sessionId: string;
  reducedMotion?: boolean;
}

export function mount(options: MountOptions): void {
  const host = document.createElement("div");
  host.id = "snufflestudy-overlay-host";
  document.body.appendChild(host);

  // Shadow DOM isolates the overlay's styles from the host page in both directions: the host
  // page's stylesheets can't reach in and restyle Snuffles, and the overlay's own rules can't
  // leak out onto arbitrary third-party pages. `mode: "open"` (not "closed") because there's
  // no adversarial threat model here - matches this project's existing "friction not security
  // boundary" posture - and open shadow roots are easier to inspect/debug via devtools.
  const shadowRoot = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = overlayStyles;
  shadowRoot.appendChild(styleEl);

  const container = document.createElement("div");
  shadowRoot.appendChild(container);

  const reducedMotion =
    options.reducedMotion ?? window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  createRoot(container).render(
    <SnufflesOverlay
      classification={options.classification}
      sessionId={options.sessionId}
      hostname={currentHostname()}
      reducedMotion={reducedMotion}
    />
  );
}
