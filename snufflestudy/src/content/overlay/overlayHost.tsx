import { createRoot } from "react-dom/client";
import { SnufflesOverlay } from "./SnufflesOverlay";
import { currentHostname } from "../siteContext";

interface MountOptions {
  classification: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";
  sessionId: string;
  reducedMotion?: boolean;
}

export function mount(options: MountOptions): void {
  const host = document.createElement("div");
  host.id = "snufflestudy-overlay-host";
  document.body.appendChild(host);

  const reducedMotion =
    options.reducedMotion ?? window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  createRoot(host).render(
    <SnufflesOverlay
      classification={options.classification}
      sessionId={options.sessionId}
      hostname={currentHostname()}
      reducedMotion={reducedMotion}
    />
  );
}
