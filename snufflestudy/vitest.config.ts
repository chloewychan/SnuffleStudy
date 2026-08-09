import { defineConfig } from "vitest/config";
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
  },
});
