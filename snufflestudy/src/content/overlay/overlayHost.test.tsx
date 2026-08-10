import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { mount } from "./overlayHost";

// This fix round rearchitected mount() around a Shadow Root specifically to isolate the
// overlay's styles from the host page in both directions (see
// task-22-fix-round-1-report.md). SnufflesOverlay.test.tsx only exercises <SnufflesOverlay />
// directly via React Testing Library's render() and never calls mount() at all, so none of
// the Shadow DOM wiring below is covered anywhere else - a regression here (e.g. someone
// "simplifying" mount() back to rendering straight into a plain <div>) would go undetected
// without a dedicated test.
describe("overlayHost mount", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("attaches an open Shadow Root containing the inlined styles and renders the overlay inside it, not in the light DOM", () => {
    act(() => {
      mount({ classification: "BLOCKED", sessionId: "session_1", reducedMotion: true });
    });

    const host = document.getElementById("snufflestudy-overlay-host");
    expect(host).not.toBeNull();

    const shadowRoot = host!.shadowRoot;
    expect(shadowRoot).not.toBeNull();
    expect(shadowRoot!.mode).toBe("open");

    // The inlined <style> must carry the :host-scoped token values .snuffles-overlay--warning
    // consumes - without these, var(--color-surface) etc. would resolve to nothing inside a
    // shadow tree, since a shadow tree's :root is the top-level document, not the host.
    const styleEl = shadowRoot!.querySelector("style");
    expect(styleEl).not.toBeNull();
    expect(styleEl!.textContent).toContain(":host");
    expect(styleEl!.textContent).toContain("--color-surface");
    expect(styleEl!.textContent).toContain(".snuffles-overlay--warning");

    // The rendered overlay lives inside the shadow tree...
    expect(shadowRoot!.querySelector(".snuffles-overlay--warning")).not.toBeNull();
    expect(shadowRoot!.textContent).toContain("That is not chemistry.");

    // ...and is NOT present in host's light DOM (host itself stays an unstyled, childless-in-
    // light-DOM attachment point), confirming isolation from the host page.
    expect(host!.querySelector(".snuffles-overlay--warning")).toBeNull();
  });

  // content/index.ts (the only real caller of mount() in production) never passes
  // `reducedMotion` explicitly, so this fallback branch — reading the live media query —
  // is what actually runs on every real page load. The test above only covers the
  // explicit-override path (reducedMotion: true), leaving this branch unexercised.
  it("falls back to window.matchMedia('(prefers-reduced-motion: reduce)') when reducedMotion isn't passed explicitly", () => {
    const matchMediaSpy = vi.fn().mockReturnValue({ matches: true } as MediaQueryList);
    vi.stubGlobal("matchMedia", matchMediaSpy);

    act(() => {
      mount({ classification: "BLOCKED", sessionId: "session_1" });
    });

    expect(matchMediaSpy).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");

    const host = document.getElementById("snufflestudy-overlay-host");
    expect(host!.shadowRoot!.textContent).toContain("That is not chemistry.");

    vi.unstubAllGlobals();
  });
});
