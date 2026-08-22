# Side Panel Figma UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SnuffleStudy's temporary side panel scaffold (`snufflestudy/src/sidepanel/SidePanelApp.tsx`) with the Figma-designed tabbed UI (Bunny / Study / Friends / Settings), wired to the existing Supabase backend through the existing message-passing layer, with no changes to the Options page.

**Architecture:** A shared `Header` + `TabBar` shell wraps four new tab components. Each tab composes *existing* panel components as-is (`FriendGroupPanel`, `StudyRoomPanel`, `UnlockRequestPanel`, `TempPasscodePanel`, `TaskVaultPage`) rather than rewriting their logic — only `SessionSetupForm` gets field-level edits. A new `ActiveSessionView` replaces the inline active-session JSX currently in `SidePanelApp.tsx`, matching the Figma "Study Session" screen (which has no tab bar — an active session still takes over the whole panel, same as today). `SidePanelApp.tsx` is reduced to: onboarding gate → (active session ? `ActiveSessionView` : tab shell) → terminal-session screens, unchanged.

**Tech Stack:** WXT + React 19 + TypeScript, Vitest + @testing-library/react, plain CSS with custom-property tokens (no Tailwind/CSS-in-JS/component library), Chrome extension messaging (`chrome.runtime.sendMessage`) as the only path to the Supabase backend.

## Global Constraints

- **Scope: side panel only.** Do not touch `snufflestudy/src/options/**` — the Options page's separate unstyled nav is explicitly out of scope for this plan.
- **Backend access is message-only.** UI components call `sendMessage()` (`src/infrastructure/messaging/extensionMessenger.ts`) — never import a `src/infrastructure/backend/*Api.ts` module directly from a UI component. The only pre-existing exceptions are inside `StudyRoomPanel.tsx` (`joinRoom`, `subscribeToPresence`) — leave those exactly as they are, do not add new direct-API-call exceptions.
- **No new message types are needed.** Every `sendMessage` call this plan makes already has a matching case in `src/background/messageRouter.ts` (verified during research: `TASK_LIST`, `SESSION_CREATE`, `SESSION_START`, `GROUP_LIST_MEMBERS`, `NUDGE_SEND`, `AUTH_GET_SESSION`, plus everything `FriendGroupPanel`/`StudyRoomPanel`/`UnlockRequestPanel`/`TempPasscodePanel` already call internally). If a task believes it needs a new message type, stop and flag it rather than adding one.
- **Styling: tokens only.** Every new color/spacing/radius/font value must reference a `var(--token-name)` defined in `src/styles/tokens.css` or `src/styles/themes.css`. No hardcoded hex/px in component CSS. Follow the existing BEM-ish naming (`block__element`, `block__element--modifier`) used by `global.css`'s three existing styled examples (`.timer-ring`, `.session-status-card`, `.snuffles-overlay`).
- **New component CSS lives in one new file**, `snufflestudy/src/styles/sidepanel.css`, imported once from `SidePanelApp.tsx` alongside the existing `global.css` import — not appended to `global.css` itself (keeps this redesign's ~7 new components' worth of CSS grouped together; `global.css` stays as the pre-existing base/shared-widget stylesheet).
- **Figma source of truth**: file key `oHeHSnxarHnN0Ly5wAsNnS`. Any task building new visual layout MUST call `get_design_context` on the node ID given in that task (include `figma-design-to-code` in `skillNames`) as its first step, and treat the returned code as reference only — adapt to plain CSS + existing tokens, never paste Tailwind classes or raw inline SVG. Icons/images come back as asset URLs; download-and-commit them under `snufflestudy/src/sidepanel/assets/` rather than linking the (≈7-day-expiring) remote URL.
- **Drop "Enter Office Building" entirely** — confirmed not to exist anywhere in the product. Do not build a button or handler for it.
- **Bunny tab is UI-only stub data** (bunny name / human name fields, show-bunny toggle, Happiness/Productivity/Friendliness meters) — confirmed no backend exists for this. Local component state only, no `sendMessage` calls, no persistence.
- **Preserve both existing mount points** for `UnlockRequestPanel` and `TempPasscodePanel`: the no-session Settings-tab listing (`session={null}`) AND the in-active-session reveal buttons. The Figma "Study Session" mock doesn't show these buttons, but they are a real, working escape hatch today and must not be removed.
- **Test convention**: Vitest + `@testing-library/react`. Mock the messaging layer with `vi.spyOn(messenger, "sendMessage").mockImplementation(...)` — never mock `chrome.runtime` directly. Stub any needed `chrome.*` surface with `vi.stubGlobal("chrome", {...})`. One colocated `<Component>.test.tsx` per new component, following the existing `SidePanelApp.test.tsx` pattern.
- **Known pre-existing landmine, not in scope**: several files under `snufflestudy/src/{sidepanel/components,shared/ui,options/pages,infrastructure/storage}` have a tracked `" 2"`-suffixed duplicate (iCloud Drive conflict-copy naming). All are byte-identical to their non-suffixed counterpart **except** `snufflestudy/src/options/pages/FriendsPage 2.tsx`, which differs from `FriendsPage.tsx` (Options-scope, so not touched by this plan, but flag it to the user separately). Do not edit any `" 2"` file in this plan; always edit the non-suffixed original.

---

## File Structure

**Modify:**
- `snufflestudy/src/styles/tokens.css` — add Figma color/font tokens
- `snufflestudy/src/styles/themes.css` — extend dark-mode overrides for new tokens
- `snufflestudy/src/sidepanel/components/SessionSetupForm.tsx` — Goal→select, Duration→hours+minutes, Restriction Mode→select
- `snufflestudy/src/sidepanel/components/SessionSetupForm.test.tsx` — updated for new field shapes
- `snufflestudy/src/sidepanel/SidePanelApp.tsx` — replace flat view-switch + inline active-session JSX with the new shell
- `snufflestudy/src/sidepanel/SidePanelApp.test.tsx` — updated for new shell

**Create:**
- `snufflestudy/src/styles/sidepanel.css`
- `snufflestudy/src/sidepanel/components/Header.tsx` + `.test.tsx`
- `snufflestudy/src/sidepanel/components/TabBar.tsx` + `.test.tsx`
- `snufflestudy/src/sidepanel/components/BunnyTab.tsx` + `.test.tsx`
- `snufflestudy/src/sidepanel/components/StudyTab.tsx` + `.test.tsx`
- `snufflestudy/src/sidepanel/components/FriendsTab.tsx` + `.test.tsx`
- `snufflestudy/src/sidepanel/components/SettingsTab.tsx` + `.test.tsx`
- `snufflestudy/src/sidepanel/components/ActiveSessionView.tsx` + `.test.tsx`
- `snufflestudy/src/sidepanel/assets/` — downloaded Figma icon/image assets (per task, as needed)

**Reused unchanged** (composed by the new tab components, not modified): `FriendGroupPanel.tsx`, `StudyRoomPanel.tsx`, `UnlockRequestPanel.tsx`, `TempPasscodePanel.tsx`, `TaskVaultPage.tsx`, `SessionStatusCard.tsx`, `TimerRing.tsx`, `PauseResumeControl.tsx`, `EndSessionControl.tsx`, `ProducerTagRecorder.tsx` (already only used internally by `FriendGroupPanel`/`StudyRoomPanel`).

---

### Task 1: Design tokens

**Files:**
- Modify: `snufflestudy/src/styles/tokens.css`
- Modify: `snufflestudy/src/styles/themes.css`
- Test: `snufflestudy/src/styles/tokens.test.ts`

**Interfaces:**
- Produces: token names `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`, `--color-primary`, `--color-accent` (new), `--font-display`, `--font-body` — every later task's CSS uses these exact names.

- [ ] **Step 1: Confirm exact values against Figma**

Call `get_design_context` (skillNames including `figma-design-to-code`) on `fileKey=oHeHSnxarHnN0Ly5wAsNnS`, `nodeId=55:230` (the Header, present on every screen — cheapest node to pull for global color/font tokens). From the response's design-token hints, confirm/correct these values gathered during planning research (verify before trusting — they were read once, not independently re-verified):
  - `--off-white: #fdfbfa` (page background)
  - `--light-pink: #f7e9dc` (card/surface background)
  - `--dark-pink: #eabab7` (accent — tab active state, primary buttons)
  - `--dark-beige: #cfc1bd` (secondary surface / borders)
  - `--light-grey: #a99d9d` (muted text)
  - `--dark-grey: #796c6c` (primary text)
  - Display font: `Pangolin`. Body font: `Shantell Sans`.

- [ ] **Step 2: Write the failing test**

```ts
// snufflestudy/src/styles/tokens.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tokensCss = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf-8"
);

describe("tokens.css", () => {
  it("defines the Figma-sourced palette and font tokens", () => {
    expect(tokensCss).toMatch(/--color-bg:\s*#fdfbfa/i);
    expect(tokensCss).toMatch(/--color-surface:\s*#f7e9dc/i);
    expect(tokensCss).toMatch(/--color-accent:\s*#eabab7/i);
    expect(tokensCss).toMatch(/--color-text:\s*#796c6c/i);
    expect(tokensCss).toMatch(/--color-text-muted:\s*#a99d9d/i);
    expect(tokensCss).toMatch(/--font-display:\s*"Pangolin"/i);
    expect(tokensCss).toMatch(/--font-body:\s*"Shantell Sans"/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/styles/tokens.test.ts`
Expected: FAIL (current `tokens.css` still has the placeholder purple palette, no font tokens).

- [ ] **Step 4: Update tokens.css**

Replace the placeholder palette (keep spacing/radius/type-scale/motion tokens as-is — only colors and fonts change) with values confirmed in Step 1:

```css
/* snufflestudy/src/styles/tokens.css */
:root {
  --color-bg: #fdfbfa;
  --color-surface: #f7e9dc;
  --color-text: #796c6c;
  --color-text-muted: #a99d9d;
  --color-primary: #eabab7;
  --color-accent: #cfc1bd;
  --color-warning: #d64b4b;
  --color-success: #2f9e5c;
  --color-caution: #d6a23a;

  --font-display: "Pangolin", cursive;
  --font-body: "Shantell Sans", sans-serif;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 16px;
  --font-size-sm: 12px;
  --font-size-md: 14px;
  --font-size-lg: 20px;
  --motion-duration-fast: 120ms;
  --motion-duration-normal: 240ms;
}

@font-face {
  font-family: "Pangolin";
  src: local("Pangolin");
  font-display: swap;
}
@font-face {
  font-family: "Shantell Sans";
  src: local("Shantell Sans");
  font-display: swap;
}
```

(If Step 1 shows the font isn't installed locally and Figma exports font files, download them into `snufflestudy/src/styles/fonts/` and point `src:` at `url(...)` instead of `local(...)` — decide based on what the design-context response actually returns.)

- [ ] **Step 5: Update themes.css dark-mode overrides**

Keep the same override structure, just recompute reasonable dark values for the new light-mode base (don't invent a separate dark Figma palette that doesn't exist — darken/desaturate proportionally, consistent with how the old placeholder dark overrides related to the old placeholder light ones):

```css
/* snufflestudy/src/styles/themes.css */
:root[data-theme="dark"],
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #201c1c;
    --color-surface: #2c2626;
    --color-text: #f2ebe9;
    --color-text-muted: #cfc1bd;
  }
}
```

(Follow whatever selector nesting the existing file already uses — read it before editing rather than assuming the shape above is exact.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/styles/tokens.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add snufflestudy/src/styles/tokens.css snufflestudy/src/styles/themes.css snufflestudy/src/styles/tokens.test.ts
git commit -m "feat(sidepanel-ui): replace placeholder tokens with Figma palette and fonts"
```

---

### Task 2: Header component

**Files:**
- Create: `snufflestudy/src/sidepanel/components/Header.tsx`
- Create: `snufflestudy/src/sidepanel/components/Header.test.tsx`
- Modify: `snufflestudy/src/styles/sidepanel.css` (new file, created by this task)

**Interfaces:**
- Consumes: `sendMessage<{ ok: boolean; session: { user: { id: string } } | null; error?: string }>({ type: "AUTH_GET_SESSION" })`
- Produces: `export function Header(): JSX.Element` — no props. Later tasks mount it as `<Header />` once, above the tab shell / above `ActiveSessionView`.

- [ ] **Step 1: Pull design context**

Call `get_design_context` (`skillNames` including `figma-design-to-code`) on `fileKey=oHeHSnxarHnN0Ly5wAsNnS`, `nodeId=55:230`. Note the "SnuffleStudy" title styling, the "Bunny and Book" image asset (download it to `snufflestudy/src/sidepanel/assets/bunny-and-book.png` or whatever format the asset export gives), and drop the "Enter Office Building" element entirely per Global Constraints.

- [ ] **Step 2: Write the failing test**

```tsx
// snufflestudy/src/sidepanel/components/Header.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Header } from "./Header";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

describe("Header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a Log-In button when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    render(<Header />);
    expect(await screen.findByRole("button", { name: /log-in/i })).toBeInTheDocument();
  });

  it("hides the Log-In button when signed in", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      session: { user: { id: "user-1" } },
    });
    render(<Header />);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /log-in/i })).not.toBeInTheDocument()
    );
  });

  it("opens the extension options page when Log-In is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: null });
    const openOptionsPage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { openOptionsPage } });
    render(<Header />);
    const button = await screen.findByRole("button", { name: /log-in/i });
    button.click();
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/Header.test.tsx`
Expected: FAIL with "Cannot find module './Header'"

- [ ] **Step 4: Implement Header.tsx**

```tsx
// snufflestudy/src/sidepanel/components/Header.tsx
import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

// Minimal shape of AUTH_GET_SESSION's response this component needs - mirrors the same
// minimal AuthUser/AuthSession shape duplicated in AccountPage.tsx and FriendGroupPanel.tsx.
interface AuthUser {
  id: string;
}
interface AuthSession {
  user: AuthUser;
}

export function Header() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loaded, setLoaded] = useState(false);

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
      <img className="sp-header__mascot" src="/assets/bunny-and-book.png" alt="" />
      <h1 className="sp-header__title">SnuffleStudy</h1>
      {loaded && !session && (
        <button
          type="button"
          className="sp-header__login-button"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Log-In
        </button>
      )}
    </header>
  );
}
```

(Adjust the `<img src>` to wherever Step 1's downloaded asset actually lands / however this project's bundler resolves static assets — check an existing `<img>` usage elsewhere in `snufflestudy/src` for the real convention before assuming `/assets/...` is correct.)

- [ ] **Step 5: Add sidepanel.css and import it**

Create `snufflestudy/src/styles/sidepanel.css` with the Header rules (using tokens from Task 1), starting the file that later tasks append to:

```css
/* snufflestudy/src/styles/sidepanel.css */
.sp-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  font-family: var(--font-body);
}

.sp-header__title {
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
  color: var(--color-text);
  margin: 0;
}

.sp-header__mascot {
  width: 40px;
  height: 40px;
  object-fit: contain;
}

.sp-header__login-button {
  margin-left: auto;
  font-family: var(--font-body);
  font-size: var(--font-size-md);
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}
```

This file gets imported once from `SidePanelApp.tsx` in Task 10 — no import needed yet in this task's test (RTL doesn't need CSS loaded to assert on DOM/roles).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/Header.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add snufflestudy/src/sidepanel/components/Header.tsx snufflestudy/src/sidepanel/components/Header.test.tsx snufflestudy/src/styles/sidepanel.css
git commit -m "feat(sidepanel-ui): add Header component"
```

---

### Task 3: TabBar component

**Files:**
- Create: `snufflestudy/src/sidepanel/components/TabBar.tsx`
- Create: `snufflestudy/src/sidepanel/components/TabBar.test.tsx`
- Modify: `snufflestudy/src/styles/sidepanel.css`

**Interfaces:**
- Produces: `export type SidePanelTab = "bunny" | "study" | "friends" | "settings";`
  `export function TabBar({ active, onSelect }: { active: SidePanelTab; onSelect: (tab: SidePanelTab) => void }): JSX.Element`
- This `SidePanelTab` type is imported by Task 10 (`SidePanelApp.tsx`) as the shell's tab state type.

- [ ] **Step 1: Pull design context**

Call `get_design_context` on `nodeId=54:104` (Tabs). Confirm the four labels and active/inactive visual states.

- [ ] **Step 2: Write the failing test**

```tsx
// snufflestudy/src/sidepanel/components/TabBar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
  it("renders all four tabs and marks the active one", () => {
    render(<TabBar active="study" onSelect={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Bunny" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Study" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Friends" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "false");
  });

  it("calls onSelect with the clicked tab", () => {
    const onSelect = vi.fn();
    render(<TabBar active="bunny" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("tab", { name: "Friends" }));
    expect(onSelect).toHaveBeenCalledWith("friends");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/TabBar.test.tsx`
Expected: FAIL with "Cannot find module './TabBar'"

- [ ] **Step 4: Implement TabBar.tsx**

```tsx
// snufflestudy/src/sidepanel/components/TabBar.tsx
export type SidePanelTab = "bunny" | "study" | "friends" | "settings";

const TABS: { id: SidePanelTab; label: string }[] = [
  { id: "bunny", label: "Bunny" },
  { id: "study", label: "Study" },
  { id: "friends", label: "Friends" },
  { id: "settings", label: "Settings" },
];

interface TabBarProps {
  active: SidePanelTab;
  onSelect: (tab: SidePanelTab) => void;
}

export function TabBar({ active, onSelect }: TabBarProps) {
  return (
    <div className="sp-tabbar" role="tablist">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={id === active}
          className={`sp-tabbar__tab${id === active ? " sp-tabbar__tab--active" : ""}`}
          onClick={() => onSelect(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Append TabBar CSS**

Append to `snufflestudy/src/styles/sidepanel.css`:

```css
.sp-tabbar {
  display: flex;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--color-accent);
}

.sp-tabbar__tab {
  font-family: var(--font-body);
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
}

.sp-tabbar__tab--active {
  color: var(--color-text);
  font-weight: 600;
  border-bottom: 2px solid var(--color-primary);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/TabBar.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add snufflestudy/src/sidepanel/components/TabBar.tsx snufflestudy/src/sidepanel/components/TabBar.test.tsx snufflestudy/src/styles/sidepanel.css
git commit -m "feat(sidepanel-ui): add TabBar component"
```

---

### Task 4: BunnyTab component (stub data)

**Files:**
- Create: `snufflestudy/src/sidepanel/components/BunnyTab.tsx`
- Create: `snufflestudy/src/sidepanel/components/BunnyTab.test.tsx`
- Modify: `snufflestudy/src/styles/sidepanel.css`

**Interfaces:**
- Produces: `export function BunnyTab(): JSX.Element` — no props, no `sendMessage` calls (per Global Constraints: UI-only stub).

- [ ] **Step 1: Pull design context**

Call `get_design_context` on `nodeId=54:164` ("About the Bun") and `nodeId=55:227` ("Status"). Confirm exact copy ("Bunny Name:", "Human Name:", "Show Bunny") and the three meter labels/colors (Happiness/Productivity/Friendliness).

- [ ] **Step 2: Write the failing test**

```tsx
// snufflestudy/src/sidepanel/components/BunnyTab.test.tsx
import { describe, it, expect, fireEvent } from "vitest";
import { render, screen } from "@testing-library/react";
import { BunnyTab } from "./BunnyTab";

describe("BunnyTab", () => {
  it("renders editable name fields with defaults", () => {
    render(<BunnyTab />);
    expect(screen.getByLabelText(/bunny name/i)).toHaveValue("Snuffles");
    expect(screen.getByLabelText(/human name/i)).toHaveValue("Hooman");
  });

  it("toggles Show Bunny", () => {
    render(<BunnyTab />);
    const toggle = screen.getByRole("checkbox", { name: /show bunny/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  it("renders the three status meters", () => {
    render(<BunnyTab />);
    expect(screen.getByText(/happiness/i)).toBeInTheDocument();
    expect(screen.getByText(/productivity/i)).toBeInTheDocument();
    expect(screen.getByText(/friendliness/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/BunnyTab.test.tsx`
Expected: FAIL with "Cannot find module './BunnyTab'"

- [ ] **Step 4: Implement BunnyTab.tsx**

```tsx
// snufflestudy/src/sidepanel/components/BunnyTab.tsx
import { useState } from "react";

// Stub data - no backend exists for bunny stats yet (confirmed during planning). Local
// component state only; nothing here is persisted or sent via sendMessage.
const STUB_METERS = [
  { label: "Happiness", percent: 85 },
  { label: "Productivity", percent: 62 },
  { label: "Friendliness", percent: 79 },
];

export function BunnyTab() {
  const [bunnyName, setBunnyName] = useState("Snuffles");
  const [humanName, setHumanName] = useState("Hooman");
  const [showBunny, setShowBunny] = useState(true);

  return (
    <div className="sp-tab-content sp-bunny-tab">
      <section className="sp-card sp-bunny-tab__about">
        <h2 className="sp-card__title">About the Bun</h2>
        <label className="sp-field">
          Bunny Name:
          <input
            value={bunnyName}
            onChange={(e) => setBunnyName(e.target.value)}
          />
        </label>
        <label className="sp-field">
          Human Name:
          <input
            value={humanName}
            onChange={(e) => setHumanName(e.target.value)}
          />
        </label>
        <label className="sp-field sp-field--checkbox">
          <input
            type="checkbox"
            checked={showBunny}
            onChange={(e) => setShowBunny(e.target.checked)}
          />
          Show Bunny
        </label>
      </section>

      <section className="sp-card sp-bunny-tab__status">
        <h2 className="sp-card__title">Status</h2>
        {STUB_METERS.map(({ label, percent }) => (
          <div key={label} className="sp-meter">
            <span className="sp-meter__label">{label}</span>
            <div className="sp-meter__track">
              <div className="sp-meter__fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Append BunnyTab CSS**

Append to `snufflestudy/src/styles/sidepanel.css` (card/field/meter classes reused by Study/Friends/Settings tabs too, so define them generically here rather than per-tab):

```css
.sp-tab-content {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sp-card {
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
}

.sp-card__title {
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
}

.sp-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-family: var(--font-body);
  color: var(--color-text);
  margin-bottom: var(--space-3);
}

.sp-field input[type="text"],
.sp-field input:not([type]) {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  padding: var(--space-2);
  font-family: var(--font-body);
}

.sp-field--checkbox {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}

.sp-meter {
  margin-bottom: var(--space-3);
}

.sp-meter__label {
  display: block;
  color: var(--color-text);
  font-family: var(--font-body);
  margin-bottom: var(--space-1);
}

.sp-meter__track {
  height: 15px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.sp-meter__fill {
  height: 100%;
  background: var(--color-primary);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/BunnyTab.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add snufflestudy/src/sidepanel/components/BunnyTab.tsx snufflestudy/src/sidepanel/components/BunnyTab.test.tsx snufflestudy/src/styles/sidepanel.css
git commit -m "feat(sidepanel-ui): add BunnyTab with stub data"
```

---

### Task 5: SessionSetupForm field changes

**Files:**
- Modify: `snufflestudy/src/sidepanel/components/SessionSetupForm.tsx`
- Modify: `snufflestudy/src/sidepanel/components/SessionSetupForm.test.tsx`

**Interfaces:**
- Consumes: `sendMessage<{ ok: boolean; tasks?: Task[]; error?: string }>({ type: "TASK_LIST" })` where `Task` is imported from `../../domain/tasks/taskTypes` (`{ id: string; title: string; createdAt: number; completedAt?: number; breakdown: TaskBreakdownItem[] }`).
- Produces: unchanged external props (`{ settings: UserSettings; initialGoal?: string; taskBreakdownItemId?: string }`) and unchanged `SESSION_CREATE` payload shape — only the internal field controls and the `focusDurationSeconds` computation change. Task 6 (`StudyTab`) mounts this component exactly as `SidePanelApp.tsx` does today.

- [ ] **Step 1: Read the current file in full**

Read `snufflestudy/src/sidepanel/components/SessionSetupForm.tsx` completely before editing — this task edits specific line ranges (goal input ~81-86, focus duration input ~88-96, restriction mode fieldset ~107-125) inside a 132-line file; get exact current line numbers before making changes, don't assume the numbers above are still exact.

- [ ] **Step 2: Write the failing tests**

Add to `snufflestudy/src/sidepanel/components/SessionSetupForm.test.tsx` (alongside its existing tests — read the existing file first to match its mocking setup exactly, e.g. how `settings` and `sendMessage` are currently stubbed):

```tsx
it("populates the Goal select from Task Vault", async () => {
  vi.spyOn(messenger, "sendMessage").mockImplementation(async (msg) => {
    if (msg.type === "TASK_LIST") {
      return {
        ok: true,
        tasks: [
          { id: "t1", title: "Finish essay", createdAt: 1, breakdown: [] },
          { id: "t2", title: "Read chapter 4", createdAt: 2, breakdown: [] },
        ],
      };
    }
    return { ok: true };
  });
  render(<SessionSetupForm settings={mockSettings} />);
  expect(await screen.findByRole("option", { name: "Finish essay" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Read chapter 4" })).toBeInTheDocument();
});

it("accepts hours and minutes for focus duration and sums them to seconds on submit", async () => {
  vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, session: mockSession });
  render(<SessionSetupForm settings={mockSettings} />);
  fireEvent.change(screen.getByLabelText(/hours/i), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText(/minutes/i), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: /start study session/i }));
  await waitFor(() =>
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SESSION_CREATE",
        payload: expect.objectContaining({ focusDurationSeconds: 5400 }),
      })
    )
  );
});

it("renders Restriction Mode as a select with soft/hard options", () => {
  render(<SessionSetupForm settings={mockSettings} />);
  const select = screen.getByLabelText(/restriction mode/i) as HTMLSelectElement;
  expect(select.tagName).toBe("SELECT");
  expect(screen.getByRole("option", { name: /soft/i })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /hard/i })).toBeInTheDocument();
});
```

(Match `mockSettings`/`mockSession` to whatever fixtures the existing test file already defines — do not redefine them if they already exist.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/SessionSetupForm.test.tsx`
Expected: FAIL (Goal is currently free text, Focus Duration is a single minutes input, Restriction Mode is radio buttons).

- [ ] **Step 4: Change Goal to a Task-Vault-backed select**

Add a `Task` fetch on mount and swap the free-text `goal` input for a `<select>`. Replace the existing free-text input block with:

```tsx
const [tasks, setTasks] = useState<Task[]>([]);

useEffect(() => {
  let cancelled = false;
  sendMessage<{ ok: boolean; tasks?: Task[]; error?: string }>({ type: "TASK_LIST" }).then((res) => {
    if (!cancelled && res.ok && res.tasks) setTasks(res.tasks);
  });
  return () => {
    cancelled = true;
  };
}, []);
```

```tsx
<label className="sp-field" htmlFor="session-goal">
  Goal
  <select
    id="session-goal"
    value={goal}
    onChange={(e) => setGoal(e.target.value)}
    required
  >
    <option value="" disabled>
      Choose a task from the Task Vault
    </option>
    {tasks.map((task) => (
      <option key={task.id} value={task.title}>
        {task.title}
      </option>
    ))}
  </select>
</label>
```

Add `import type { Task } from "../../domain/tasks/taskTypes";` at the top. Keep `goal: string` state and the `SESSION_CREATE` payload's `goal` field exactly as before — only how the string gets set changes. If `initialGoal` is passed as a prop (the "start from a Task Vault breakdown item" flow), keep the existing logic that seeds `goal` from it; that value may not match any `tasks[].title` exactly (it can come from a breakdown item's description) — don't force-match it into the select's options list, just let the initial `<select>` value be whatever `initialGoal` was and allow the user to change it.

- [ ] **Step 5: Change Focus Duration to hours + minutes**

Replace the single `focusMinutes` number state with two fields:

```tsx
const [focusHours, setFocusHours] = useState(0);
const [focusMinutes, setFocusMinutes] = useState(
  Math.round((settings.defaultFocusDurationSeconds % 3600) / 60)
);
```

(Initialize `focusHours` from `Math.floor(settings.defaultFocusDurationSeconds / 3600)`.)

```tsx
<fieldset className="sp-field">
  <legend>Focus Duration</legend>
  <label htmlFor="session-focus-hours">
    Hours
    <input
      id="session-focus-hours"
      type="number"
      min={0}
      max={3}
      value={focusHours}
      onChange={(e) => setFocusHours(Number(e.target.value))}
    />
  </label>
  <label htmlFor="session-focus-minutes">
    Minutes
    <input
      id="session-focus-minutes"
      type="number"
      min={0}
      max={59}
      value={focusMinutes}
      onChange={(e) => setFocusMinutes(Number(e.target.value))}
    />
  </label>
</fieldset>
```

In `handleSubmit`, change `focusDurationSeconds: focusMinutes * 60` to `focusDurationSeconds: focusHours * 3600 + focusMinutes * 60`.

- [ ] **Step 6: Change Restriction Mode from radio fieldset to a select**

Replace the two-radio-button `<fieldset>` with:

```tsx
<label className="sp-field" htmlFor="session-restriction-mode">
  Restriction Mode
  <select
    id="session-restriction-mode"
    value={restrictionMode}
    onChange={(e) => setRestrictionMode(e.target.value as "soft" | "hard")}
  >
    <option value="soft">Soft - nudge &amp; escalate</option>
    <option value="hard">Hard</option>
  </select>
</label>
```

(Confirm the exact "hard" option label against `get_design_context` on `nodeId=58:450` if the Figma mock shows specific copy — the plan text above is a placeholder-but-real default matching the existing radio option's label, not a TBD; adjust only the visible label text if Figma differs, the `value="hard"` must stay exactly `"hard"` to match `RestrictionMode` from `domain/session/sessionTypes.ts`.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/SessionSetupForm.test.tsx`
Expected: PASS (including all pre-existing tests in the file — re-run the full file, not just the new tests, since Steps 4-6 touch shared state).

- [ ] **Step 8: Commit**

```bash
git add snufflestudy/src/sidepanel/components/SessionSetupForm.tsx snufflestudy/src/sidepanel/components/SessionSetupForm.test.tsx
git commit -m "feat(sidepanel-ui): Goal as Task Vault select, hours+minutes duration, Restriction Mode select"
```

---

### Task 6: StudyTab component

**Files:**
- Create: `snufflestudy/src/sidepanel/components/StudyTab.tsx`
- Create: `snufflestudy/src/sidepanel/components/StudyTab.test.tsx`
- Modify: `snufflestudy/src/styles/sidepanel.css`

**Interfaces:**
- Consumes: `SessionSetupForm` (Task 5's updated props, unchanged shape: `{ settings: UserSettings; initialGoal?: string; taskBreakdownItemId?: string }`), `TaskVaultPage` (`{ onClose: () => void; onStartSessionFromBreakdownItem: (params: { goal: string; taskBreakdownItemId: string }) => void }`).
- Produces: `export function StudyTab({ settings }: { settings: UserSettings }): JSX.Element`

- [ ] **Step 1: Pull design context**

Call `get_design_context` on `nodeId=58:450` (Study Session setup card) and `nodeId=58:535` (Task Vault card) to confirm the stacked-card layout.

- [ ] **Step 2: Write the failing test**

```tsx
// snufflestudy/src/sidepanel/components/StudyTab.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StudyTab } from "./StudyTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });

describe("StudyTab", () => {
  it("renders both the session setup form and the task vault", () => {
    render(<StudyTab settings={mockSettings} />);
    expect(screen.getByRole("button", { name: /start study session/i })).toBeInTheDocument();
    expect(screen.getByText(/task vault/i)).toBeInTheDocument();
  });

  it("prefills Goal when a breakdown item is chosen from Task Vault", async () => {
    render(<StudyTab settings={mockSettings} />);
    // TaskVaultPage's onStartSessionFromBreakdownItem callback flows into
    // SessionSetupForm's initialGoal/taskBreakdownItemId props - exact trigger element
    // depends on TaskVaultPage's real markup; read TaskVaultPage.tsx to target it precisely
    // rather than guessing a selector here.
  });
});
```

(Reuse whatever `mockSettings` fixture Task 5's test file defines — import it or redefine identically, matching that file's existing pattern.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/StudyTab.test.tsx`
Expected: FAIL with "Cannot find module './StudyTab'"

- [ ] **Step 4: Implement StudyTab.tsx**

```tsx
// snufflestudy/src/sidepanel/components/StudyTab.tsx
import { useState } from "react";
import { SessionSetupForm } from "./SessionSetupForm";
import { TaskVaultPage } from "../../app/routes/TaskVaultPage";
import type { UserSettings } from "../../domain/settings/userSettings";

interface StudyTabProps {
  settings: UserSettings;
}

export function StudyTab({ settings }: StudyTabProps) {
  const [prefill, setPrefill] = useState<{ goal: string; taskBreakdownItemId: string } | null>(
    null
  );

  return (
    <div className="sp-tab-content sp-study-tab">
      <section className="sp-card">
        <SessionSetupForm
          settings={settings}
          initialGoal={prefill?.goal}
          taskBreakdownItemId={prefill?.taskBreakdownItemId}
        />
      </section>
      <section className="sp-card">
        <TaskVaultPage
          onClose={() => {}}
          onStartSessionFromBreakdownItem={(params) => setPrefill(params)}
        />
      </section>
    </div>
  );
}
```

`TaskVaultPage`'s `onClose` is a no-op here: unlike its original routed-page usage (where `onClose` navigates back to the setup view), both cards are always visible side by side in this tab, so there's nowhere to "close" to. If `TaskVaultPage` renders a visible close/back button tied to that prop, note it in the PR description as a known minor visual leftover rather than modifying `TaskVaultPage.tsx` itself (out of this task's scope — flag for a follow-up if it looks wrong once rendered).

- [ ] **Step 5: Append StudyTab CSS**

`.sp-study-tab` needs no new rules beyond `.sp-tab-content`/`.sp-card` already defined in Task 4 — skip this step unless `get_design_context` in Step 1 reveals spacing that genuinely differs from the existing `.sp-tab-content` gap.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/StudyTab.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add snufflestudy/src/sidepanel/components/StudyTab.tsx snufflestudy/src/sidepanel/components/StudyTab.test.tsx
git commit -m "feat(sidepanel-ui): add StudyTab composing SessionSetupForm and TaskVaultPage"
```

---

### Task 7: FriendsTab component

**Files:**
- Create: `snufflestudy/src/sidepanel/components/FriendsTab.tsx`
- Create: `snufflestudy/src/sidepanel/components/FriendsTab.test.tsx`

**Interfaces:**
- Consumes: `FriendGroupPanel` (`{ onClose: () => void }` — already internally renders friend list + Producer Tags per research), `StudyRoomPanel` (`{ onClose: () => void }` — already internally handles browse/create/join AND in-room participants).
- Produces: `export function FriendsTab(): JSX.Element`

- [ ] **Step 1: Pull design context**

Call `get_design_context` on `nodeId=58:471` (whole Friends screen — pulled as one node since its Producer Tags section has no clean wrapping frame in the Figma file; see plan research notes). Confirm layout order: Friends list, then Study Rooms, then Producer Tags.

- [ ] **Step 2: Write the failing test**

```tsx
// snufflestudy/src/sidepanel/components/FriendsTab.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FriendsTab } from "./FriendsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, members: [], rooms: [] });

describe("FriendsTab", () => {
  it("renders both FriendGroupPanel and StudyRoomPanel", () => {
    render(<FriendsTab />);
    // FriendGroupPanel and StudyRoomPanel each render their own headings - read their
    // source (already read during planning research) to assert on their real heading text
    // rather than guessing; this is a smoke test that both mount without throwing.
    expect(document.querySelectorAll(".sp-friends-tab > section").length).toBe(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/FriendsTab.test.tsx`
Expected: FAIL with "Cannot find module './FriendsTab'"

- [ ] **Step 4: Implement FriendsTab.tsx**

```tsx
// snufflestudy/src/sidepanel/components/FriendsTab.tsx
import { FriendGroupPanel } from "./FriendGroupPanel";
import { StudyRoomPanel } from "./StudyRoomPanel";

export function FriendsTab() {
  return (
    <div className="sp-tab-content sp-friends-tab">
      <section>
        <FriendGroupPanel onClose={() => {}} />
      </section>
      <section>
        <StudyRoomPanel onClose={() => {}} />
      </section>
    </div>
  );
}
```

Both `onClose` props are no-ops for the same reason as Task 6's `TaskVaultPage`: these were originally routed pages with a back button, now permanently embedded side by side in a tab. If either renders a visible close button, flag it in the PR description rather than modifying the reused component.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/FriendsTab.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add snufflestudy/src/sidepanel/components/FriendsTab.tsx snufflestudy/src/sidepanel/components/FriendsTab.test.tsx
git commit -m "feat(sidepanel-ui): add FriendsTab composing FriendGroupPanel and StudyRoomPanel"
```

---

### Task 8: SettingsTab component

**Files:**
- Create: `snufflestudy/src/sidepanel/components/SettingsTab.tsx`
- Create: `snufflestudy/src/sidepanel/components/SettingsTab.test.tsx`

**Interfaces:**
- Consumes: `UnlockRequestPanel` (`{ session: StudySession | null; onClose: () => void }` — pass `session={null}` so only the "pending requests from others" approver section renders, per its documented behavior), `TempPasscodePanel` (`{ onClose: () => void }`).
- Produces: `export function SettingsTab(): JSX.Element`

- [ ] **Step 1: Pull design context**

Call `get_design_context` on `nodeId=61:923` (Passcode Requests card). Confirm the two sub-sections' labels ("Temporary Requests", "Unlock Requests") match `TempPasscodePanel`/`UnlockRequestPanel`'s own internal headings — if they differ, that's just this card's copy, not something to force-rename inside the reused components.

- [ ] **Step 2: Write the failing test**

```tsx
// snufflestudy/src/sidepanel/components/SettingsTab.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SettingsTab } from "./SettingsTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, requests: [] });

describe("SettingsTab", () => {
  it("renders both UnlockRequestPanel (session=null) and TempPasscodePanel without throwing", () => {
    expect(() => render(<SettingsTab />)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/SettingsTab.test.tsx`
Expected: FAIL with "Cannot find module './SettingsTab'"

- [ ] **Step 4: Implement SettingsTab.tsx**

```tsx
// snufflestudy/src/sidepanel/components/SettingsTab.tsx
import { UnlockRequestPanel } from "./UnlockRequestPanel";
import { TempPasscodePanel } from "./TempPasscodePanel";

export function SettingsTab() {
  return (
    <div className="sp-tab-content sp-settings-tab">
      <section>
        <UnlockRequestPanel session={null} onClose={() => {}} />
      </section>
      <section>
        <TempPasscodePanel onClose={() => {}} />
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/SettingsTab.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add snufflestudy/src/sidepanel/components/SettingsTab.tsx snufflestudy/src/sidepanel/components/SettingsTab.test.tsx
git commit -m "feat(sidepanel-ui): add SettingsTab composing UnlockRequestPanel and TempPasscodePanel"
```

---

### Task 9: ActiveSessionView component

**Files:**
- Create: `snufflestudy/src/sidepanel/components/ActiveSessionView.tsx`
- Create: `snufflestudy/src/sidepanel/components/ActiveSessionView.test.tsx`
- Modify: `snufflestudy/src/styles/sidepanel.css`

**Interfaces:**
- Consumes: `SessionStatusCard` (`{ session: StudySession }`), `TimerRing` (`{ remainingSeconds: number; totalSeconds: number }`), `PauseResumeControl` (`{ session: StudySession }`), `EndSessionControl` (`{ session: StudySession }`), `remainingSeconds()` from `../../domain/session/timer`, `useNow()` from `../../popup/hooks/useNow`. `sendMessage` calls: `{ type: "GROUP_LIST_MEMBERS", payload: { groupId: string } }` → `{ ok: true, members: GroupMembership[] }`, `{ type: "NUDGE_SEND", payload: { friendUserId: string; messageId: string } }`.
- Produces: `export function ActiveSessionView({ session, onShowUnlockPanel, onShowTempPasscodePanel }: { session: StudySession; onShowUnlockPanel: () => void; onShowTempPasscodePanel: () => void }): JSX.Element`. Task 10 mounts this in place of the inline active-session JSX currently in `SidePanelApp.tsx`, still gating `UnlockRequestPanel`/`TempPasscodePanel` visibility with its own `showUnlockPanel`/`showTempPasscodePanel` state exactly as today (this component only renders the two trigger buttons — the actual panels stay mounted by `SidePanelApp.tsx`, unchanged).

- [ ] **Step 1: Read SidePanelApp.tsx's current active-session branch in full**

Read the current active-session JSX (originally reported around lines 226-246, confirm exact current lines) before writing this component, so the extraction is a faithful lift-and-adapt, not a guess.

- [ ] **Step 2: Pull design context**

Call `get_design_context` on `nodeId=60:774` (whole "Study Session" screen — pulled as one node; its "during-session Study Room" content has no clean wrapping frame, same reasoning as Task 7's Friends screen). Confirm layout: goal name display, "Study Session in Progress" card (Pause/End Session, Activity Status, Focus Status), then a friends panel with Nudge / Send Producer Tag actions.

Note on that friends panel: `StudySession` has no room/`roomId` field (confirmed during planning research) — it has `accountabilityGroupId`/`accountabilityUserIds`. The Figma "Study Room" panel is built here against the session's **accountability group**, not a LiveKit `StudyRoom`. `NUDGE_SEND` requires a specific `friendUserId` (not a bulk action), so render Nudge per friend row even though the Figma mock shows one representative button — this is a deliberate adaptation to real data shape, not a copy of the mock's exact button count.

- [ ] **Step 3: Write the failing test**

```tsx
// snufflestudy/src/sidepanel/components/ActiveSessionView.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ActiveSessionView } from "./ActiveSessionView";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

const mockSession = {
  id: "s1",
  goal: "Finish essay",
  state: "FOCUSING" as const,
  interventionLevel: "none" as const,
  activityState: "active" as const,
  createdAt: 0,
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  remainingSeconds: 900,
  pressureProfileId: "p1",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft" as const,
  accountabilityGroupId: "g1",
  accountabilityUserIds: ["u2"],
  distractionAttempts: 0,
  recoveries: 0,
  friendNudges: 0,
};

describe("ActiveSessionView", () => {
  it("renders the goal, timer, and pause/end controls", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      members: [{ userId: "u2", groupId: "g1", displayName: "Alex" }],
    });
    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
    );
    expect(screen.getByText("Finish essay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /end session/i })).toBeInTheDocument();
    expect(await screen.findByText("Alex")).toBeInTheDocument();
  });

  it("sends a nudge to the selected friend", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      members: [{ userId: "u2", groupId: "g1", displayName: "Alex" }],
    });
    render(
      <ActiveSessionView
        session={mockSession}
        onShowUnlockPanel={vi.fn()}
        onShowTempPasscodePanel={vi.fn()}
      />
    );
    const nudgeButton = await screen.findByRole("button", { name: /nudge alex/i });
    nudgeButton.click();
    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "NUDGE_SEND",
          payload: expect.objectContaining({ friendUserId: "u2" }),
        })
      )
    );
  });
});
```

(Confirm `GroupMembership`'s exact field names — `userId`/`groupId`/`displayName` above are a best guess from the type's usage pattern; read `src/infrastructure/backend/friendGroupApi.ts`'s `GroupMembership` export before finalizing this test.)

- [ ] **Step 4: Run test to verify it fails**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/ActiveSessionView.test.tsx`
Expected: FAIL with "Cannot find module './ActiveSessionView'"

- [ ] **Step 5: Implement ActiveSessionView.tsx**

```tsx
// snufflestudy/src/sidepanel/components/ActiveSessionView.tsx
import { useEffect, useState } from "react";
import { SessionStatusCard } from "../../shared/ui/SessionStatusCard";
import { TimerRing } from "../../shared/ui/TimerRing";
import { PauseResumeControl } from "../../shared/ui/PauseResumeControl";
import { EndSessionControl } from "../../shared/ui/EndSessionControl";
import { useNow } from "../../popup/hooks/useNow";
import { remainingSeconds as computeRemainingSeconds } from "../../domain/session/timer";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { NUDGE_MESSAGES } from "../../domain/accountability/nudgeMessages";
import type { StudySession } from "../../domain/session/sessionTypes";
import type { GroupMembership } from "../../infrastructure/backend/friendGroupApi";

interface ActiveSessionViewProps {
  session: StudySession;
  onShowUnlockPanel: () => void;
  onShowTempPasscodePanel: () => void;
}

export function ActiveSessionView({
  session,
  onShowUnlockPanel,
  onShowTempPasscodePanel,
}: ActiveSessionViewProps) {
  const now = useNow();
  const remaining = computeRemainingSeconds(session, now);
  const [members, setMembers] = useState<GroupMembership[]>([]);

  useEffect(() => {
    if (!session.accountabilityGroupId) return;
    let cancelled = false;
    sendMessage<{ ok: boolean; members?: GroupMembership[] }>({
      type: "GROUP_LIST_MEMBERS",
      payload: { groupId: session.accountabilityGroupId },
    }).then((res) => {
      if (!cancelled && res.ok && res.members) setMembers(res.members);
    });
    return () => {
      cancelled = true;
    };
  }, [session.accountabilityGroupId]);

  function nudge(friendUserId: string) {
    sendMessage({
      type: "NUDGE_SEND",
      payload: { friendUserId, messageId: NUDGE_MESSAGES[0].id },
    });
  }

  return (
    <div className="sp-tab-content sp-active-session">
      <h2 className="sp-active-session__goal">{session.goal}</h2>

      <section className="sp-card">
        <TimerRing remainingSeconds={remaining} totalSeconds={session.focusDurationSeconds} />
        <SessionStatusCard session={session} />
        <div className="sp-active-session__controls">
          <PauseResumeControl session={session} />
          <EndSessionControl session={session} />
        </div>
      </section>

      <section className="sp-card sp-active-session__room">
        <h3 className="sp-card__title">Study Room</h3>
        <ul className="sp-active-session__friend-list">
          {members.map((member) => (
            <li key={member.userId}>
              <span>{member.displayName}</span>
              <button type="button" onClick={() => nudge(member.userId)}>
                Nudge {member.displayName}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="sp-active-session__escape-hatches">
        <button type="button" onClick={onShowUnlockPanel}>
          Request Unlock
        </button>
        <button type="button" onClick={onShowTempPasscodePanel}>
          Temp Passcode
        </button>
      </div>
    </div>
  );
}
```

(The "Send Producer Tag" action from the Figma mock is deliberately deferred: it needs the same record/preview/send flow `ProducerTagRecorder` already provides inside `FriendGroupPanel`, targeted per-friend via `producerTagApi`'s `uploadTag` + `sendToFriend` — reachable only via `sendMessage` equivalents of those two calls. Confirm the exact message-router case names for producer-tag upload/send before wiring this in; if `messageRouter.ts` doesn't yet expose per-friend producer-tag sending as a message type distinct from what `FriendGroupPanel` already uses internally, reuse that exact same pattern rather than inventing a new one. Given this plan's Global Constraint against adding new message types, treat this as a candidate follow-up task rather than blocking this task's own test suite, which does not assert on it.)

- [ ] **Step 6: Append ActiveSessionView CSS**

Append to `snufflestudy/src/styles/sidepanel.css`:

```css
.sp-active-session__goal {
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
  color: var(--color-text);
  text-align: center;
}

.sp-active-session__controls {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.sp-active-session__friend-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sp-active-session__friend-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sp-active-session__escape-hatches {
  display: flex;
  gap: var(--space-2);
  justify-content: center;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd snufflestudy && npx vitest run src/sidepanel/components/ActiveSessionView.test.tsx`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add snufflestudy/src/sidepanel/components/ActiveSessionView.tsx snufflestudy/src/sidepanel/components/ActiveSessionView.test.tsx snufflestudy/src/styles/sidepanel.css
git commit -m "feat(sidepanel-ui): add ActiveSessionView replacing inline active-session layout"
```

---

### Task 10: Wire SidePanelApp.tsx

**Files:**
- Modify: `snufflestudy/src/sidepanel/SidePanelApp.tsx`
- Modify: `snufflestudy/src/sidepanel/SidePanelApp.test.tsx`

**Interfaces:**
- Consumes: `Header` (Task 2), `TabBar`/`SidePanelTab` (Task 3), `BunnyTab` (Task 4), `StudyTab` (Task 6), `FriendsTab` (Task 7), `SettingsTab` (Task 8), `ActiveSessionView` (Task 9).
- Produces: the final `SidePanelApp` render tree used by the extension at runtime.

- [ ] **Step 1: Read the full current file**

Read `snufflestudy/src/sidepanel/SidePanelApp.tsx` (247 lines) in full immediately before editing — this task replaces specific branches (the `SidePanelView`-routed no-session block, lines ~110-156 and ~160-179; the inline active-session JSX, lines ~226-246) while preserving others exactly (loading/error states ~87-95, `OnboardingWizard` gate ~97-109, `CompletionScreen`/`AbandonedScreen` ~184-198). Confirm exact current line numbers before editing, since Tasks 1-9's work didn't touch this file and line numbers may have drifted from the original research pass.

- [ ] **Step 2: Update failing tests first**

Update `snufflestudy/src/sidepanel/SidePanelApp.test.tsx`: any existing test that asserts on the old 5-button scaffold or the `SidePanelView` union (e.g. clicking "Task Vault" button to switch views) must be rewritten to assert on the new `TabBar` instead (e.g. `fireEvent.click(screen.getByRole("tab", { name: "Friends" }))`). Read the existing test file first and adapt each assertion individually — don't delete and rewrite tests wholesale, since some (onboarding gate, completion/abandoned screens, loading/error states) don't change at all and should keep passing unmodified once the import paths still resolve.

- [ ] **Step 3: Run tests to verify the expected failures**

Run: `cd snufflestudy && npx vitest run src/sidepanel/SidePanelApp.test.tsx`
Expected: FAIL on the tab-related assertions (old buttons no longer exist), PASS still on unrelated ones (onboarding/completion/abandoned) — confirms the test updates target the right seams before touching the component.

- [ ] **Step 4: Replace the no-session view-switch block**

Remove the `SidePanelView` type and all `view`/`setView` state. Replace with:

```tsx
import { TabBar, type SidePanelTab } from "./components/TabBar";
import { Header } from "./components/Header";
import { BunnyTab } from "./components/BunnyTab";
import { StudyTab } from "./components/StudyTab";
import { FriendsTab } from "./components/FriendsTab";
import { SettingsTab } from "./components/SettingsTab";
import { ActiveSessionView } from "./components/ActiveSessionView";
import "../styles/sidepanel.css";
```

```tsx
const [activeTab, setActiveTab] = useState<SidePanelTab>("bunny");
```

Replace the no-session branch's rendering with:

```tsx
if (!session) {
  return (
    <>
      <Header />
      <TabBar active={activeTab} onSelect={setActiveTab} />
      {activeTab === "bunny" && <BunnyTab />}
      {activeTab === "study" && <StudyTab settings={settings} />}
      {activeTab === "friends" && <FriendsTab />}
      {activeTab === "settings" && <SettingsTab />}
    </>
  );
}
```

- [ ] **Step 5: Replace the inline active-session JSX**

Replace the active-session render branch (the `SessionStatusCard`/`TimerRing`/restricted-sites/`PauseResumeControl`/`EndSessionControl` block plus the two `show*Panel`-toggling buttons) with:

```tsx
return (
  <>
    <Header />
    <ActiveSessionView
      session={session}
      onShowUnlockPanel={() => setShowUnlockPanel(true)}
      onShowTempPasscodePanel={() => setShowTempPasscodePanel(true)}
    />
    {showUnlockPanel && (
      <UnlockRequestPanel session={session} onClose={() => setShowUnlockPanel(false)} />
    )}
    {showTempPasscodePanel && (
      <TempPasscodePanel onClose={() => setShowTempPasscodePanel(false)} />
    )}
  </>
);
```

Keep `showUnlockPanel`/`showTempPasscodePanel` state, the `UnlockRequestPanel`/`TempPasscodePanel` imports, and the `CompletionScreen`/`ABANDONED` branches exactly as they are today — only the "else" (active FOCUSING/PAUSED/BREAK) branch's inner JSX changes.

- [ ] **Step 6: Remove now-dead code**

Delete the old inline 5-button list and any now-unused imports (`TaskVaultPage`, `FriendGroupPanel`, `StudyRoomPanel` direct imports from `SidePanelApp.tsx` itself — they're still used, just now inside `StudyTab`/`FriendsTab` instead of here). Run a type-check to confirm nothing is orphaned:

Run: `cd snufflestudy && npx tsc --noEmit`
Expected: no unused-import or unused-variable errors.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd snufflestudy && npx vitest run src/sidepanel/SidePanelApp.test.tsx`
Expected: PASS (all of it — updated tab tests and untouched onboarding/completion/abandoned tests alike).

- [ ] **Step 8: Run the full test suite**

Run: `cd snufflestudy && npx vitest run`
Expected: PASS — this is the integration point for every task in this plan; a regression anywhere in Tasks 1-9 would most likely surface here first.

- [ ] **Step 9: Manual verification in a loaded extension build**

Build and load the extension (`cd snufflestudy && npm run build`, then load `snufflestudy/.output/chrome-mv3` as an unpacked extension in Chrome), open the side panel, and walk: each of the 4 tabs render with real backend data; starting a session switches to `ActiveSessionView`; the Unlock/Temp-Passcode buttons still work mid-session; ending/completing a session returns to the tab shell.

- [ ] **Step 10: Commit**

```bash
git add snufflestudy/src/sidepanel/SidePanelApp.tsx snufflestudy/src/sidepanel/SidePanelApp.test.tsx
git commit -m "feat(sidepanel-ui): wire tab shell and ActiveSessionView into SidePanelApp, remove temp scaffold"
```

---

## Self-Review Notes

- **Spec coverage**: IA-follows-Figma (Task 10's tab routing) ✓, drop "Enter Office Building" (Task 2 omits it) ✓, Bunny stub data (Task 4) ✓, Goal-from-Task-Vault (Task 5) ✓, hours+minutes duration (Task 5) ✓, Pressure Style dropdown kept as-is (no task touches it — confirmed already a `<select>`, nothing to change) ✓, Restriction Mode as dropdown (Task 5) ✓, side-panel-only scope (Global Constraints; no task touches `src/options/`) ✓.
- **Open items flagged for post-plan-review rather than blocking**: the `onClose` no-op pattern on reused routed-page components (Tasks 6-8) may leave a visually stray close button — cheap to fix once seen rendered, not worth a speculative `TaskVaultPage`/`FriendGroupPanel`/`StudyRoomPanel`/`UnlockRequestPanel`/`TempPasscodePanel` prop-signature change now; the "Send Producer Tag" action in `ActiveSessionView` (Task 9) is deferred pending confirming the exact message-router case for per-friend producer-tag sending; the `FriendsPage 2.tsx` iCloud conflict-copy (Options scope) needs the user's own resolution, unrelated to this plan's execution.
