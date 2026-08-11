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
