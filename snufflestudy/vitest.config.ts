import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // No test files exist yet in this scaffolding task; without this, Vitest's default
    // behavior is to exit 1 when zero test files match, which reads as a failure.
    passWithNoTests: true,
  },
});
