// src/content/overlay/overlayStyles.ts
//
// CSS injected as inline text into the Shadow Root created by overlayHost.tsx's mount(),
// exported as a plain template-literal string constant rather than a `.css` file.
//
// Two Vite/WXT CSS-file import queries were tried first and both were rejected:
//   - A plain `import "./overlay.css"` crashes `npm run build` for the content-script bundle
//     ("Cannot read properties of undefined (reading 'get')", inside Vite's CSS-modules-cache
//     handling for this build target).
//   - `import overlayStyles from "./overlay.css?inline"` hits the exact same crash - it still
//     routes through Vite's CSS-file transform pipeline.
//   - `import overlayStyles from "./overlay.css?raw"` does NOT crash `npm run build` (confirmed:
//     the built .output/chrome-mv3/content-scripts/content.js contains the real CSS text), but
//     under Vitest's SSR-mode transform (via the WxtVitest plugin) it silently resolves to an
//     empty string instead of throwing - a `.css` file still gets intercepted by Vite's CSS
//     plugin ahead of the raw/inline query in that pipeline, unlike a plain `.txt` file (which
//     was used to confirm `?raw` itself works correctly against a non-.css extension under
//     Vitest). A silent empty-string mismatch between the real build and the test environment is
//     worse than a loud crash: it would make `overlayHost.test.tsx` "pass" while asserting
//     against content that isn't really the overlay's CSS, and offers no way to verify the
//     styles that actually ship. A `.ts` module exporting a template literal bypasses Vite's CSS
//     pipeline entirely, so it behaves identically under `npm run build` and under Vitest.
//
// `:root` inside a Shadow Root still resolves to the top-level *document* root, not the shadow
// host - and on a third-party host page that document's `:root` won't have any of tokens.css's
// custom properties defined at all. The `:host` block below redefines just the tokens
// `.snuffles-overlay`/`.snuffles-overlay--warning` actually consume (see src/styles/tokens.css),
// scoped to this shadow tree, so they resolve correctly regardless of what (if anything) the
// host page's own document defines on its `:root`. global.css's `*`/`body` resets are
// deliberately not reproduced here - those are page-level defaults for the extension's own full
// pages, not relevant inside an isolated shadow tree with no host-page elements to reset.
export const overlayStyles = `
:host {
  --color-surface: #f5f5f7;
  --radius-md: 8px;
  --space-3: 16px;
}

.snuffles-overlay {
  position: fixed;
  z-index: 2147483647;
}

.snuffles-overlay--warning {
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
}
`;
