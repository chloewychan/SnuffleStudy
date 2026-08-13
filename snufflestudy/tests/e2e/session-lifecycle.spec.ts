import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";

let context: BrowserContext;

test.beforeAll(async () => {
  // This project's package.json sets "type": "module", so Playwright loads this spec as
  // ESM — CommonJS's `__dirname` isn't defined here. `import.meta.dirname` (Node 20.11+)
  // is the ESM-native equivalent.
  const pathToExtension = path.join(import.meta.dirname, "../../.output/chrome-mv3");
  // headless: true alone resolves to `chrome-headless-shell` in this Playwright version
  // (the old headless architecture, launched with --headless=old), which also forces
  // --disable-extensions and silently prevents the extension's service worker from ever
  // starting. Passing channel: "chromium" makes Playwright launch the full Chrome for
  // Testing binary in the new headless mode instead, which does support loading unpacked
  // extensions — confirmed empirically before writing this. See task-23-report.md.
  context = await chromium.launchPersistentContext("", {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
  });
});

test.afterAll(async () => {
  await context.close();
});

test("a session can be created from the side panel and shows a running timer", async () => {
  let [background] = context.serviceWorkers();
  if (!background) background = await context.waitForEvent("serviceworker");
  const extensionId = background.url().split("/")[2];

  // Pre-seed settings so the test exercises session setup, not onboarding —
  // onboarding's own flow is already covered by Task 16's component test.
  await background.evaluate(() => {
    return chrome.storage.local.set({
      "snufflestudy.settings": {
        pressureProfileId: "strict-coach",
        trackingTier: "activity-only",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: ["youtube.com"],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
    });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await page.getByPlaceholder("Finish 20 chemistry problems").fill("Read chapter 3");
  await page.getByRole("button", { name: "Start session" }).click();

  await expect(page.getByText("Read chapter 3")).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();

  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByPlaceholder("Finish 20 chemistry problems")).toBeVisible();
});

test("a very short session completes naturally via a real alarm and shows the completion screen", async () => {
  // Regression coverage for a real user report: previously a naturally-completed session was
  // archived and its active-session entry cleared in the same instant (alarmHandlers.ts), so
  // neither the popup nor the side panel ever got a chance to render an acknowledgment - it
  // just silently snapped back to "no active session," which looked exactly like nothing had
  // happened. A generous per-test timeout accommodates chrome.alarms' real-world scheduling
  // slack (Chrome does not guarantee sub-minute alarm precision even for a 2-second request).
  test.setTimeout(90_000);

  let [background] = context.serviceWorkers();
  if (!background) background = await context.waitForEvent("serviceworker");
  const extensionId = background.url().split("/")[2];

  // Seed an already-running session directly instead of going through SessionSetupForm's UI:
  // its focus-duration field enforces a real HTML5 min={5}-minutes constraint, which silently
  // blocks native form submission for anything shorter (no error surfaces - the browser just
  // refuses to submit). Writing the session + scheduling the real alarm the same way
  // messageRouter.ts's SESSION_START handler does exercises the actual natural-completion path
  // (alarmHandlers.ts, real chrome.alarms, real chrome.notifications) without waiting through
  // a full 5+ minute session to reach it.
  await background.evaluate(async () => {
    const now = Date.now();
    const session = {
      id: "e2e-quick-session",
      goal: "Quick check",
      state: "FOCUSING",
      interventionLevel: "none",
      activityState: "active",
      createdAt: now,
      startedAt: now,
      plannedEndAt: now + 2000,
      focusDurationSeconds: 2,
      breakDurationSeconds: 300,
      pressureProfileId: "strict-coach",
      allowedSites: [],
      restrictedSites: [],
      restrictionMode: "soft",
      accountabilityUserIds: [],
      distractionAttempts: 0,
      recoveries: 0,
      friendNudges: 0,
    };
    await chrome.storage.local.set({
      "snufflestudy.settings": {
        pressureProfileId: "strict-coach",
        trackingTier: "activity-only",
        defaultFocusDurationSeconds: 1500,
        defaultBreakDurationSeconds: 300,
        defaultAllowedSites: [],
        defaultRestrictedSites: [],
        defaultRestrictionMode: "soft",
        onboardingCompleted: true,
      },
      "snufflestudy.activeSession": session,
    });
    chrome.alarms.create("snufflestudy-session-timer", { when: now + 2000 });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await expect(page.getByRole("timer")).toBeVisible();

  await expect(page.getByText("Goal complete!")).toBeVisible({ timeout: 75_000 });
  await expect(page.getByText("Quick check")).toBeVisible();

  await page.getByRole("button", { name: "Start another session" }).click();
  await expect(page.getByPlaceholder("Finish 20 chemistry problems")).toBeVisible();
});
