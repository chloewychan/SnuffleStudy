import { defineConfig, configDefaults } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // No test files exist yet in this scaffolding task; without this, Vitest's default
    // behavior is to exit 1 when zero test files match, which reads as a failure.
    passWithNoTests: true,
    // tests/e2e/** holds Playwright specs (run via `playwright test`, not Vitest). Vitest's
    // default include glob (**/*.spec.ts) would otherwise pick them up and try to execute
    // Playwright's test.beforeAll() outside a Playwright runner, which fails immediately.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
