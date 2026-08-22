import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const tokensCss = readFileSync(join(__dirname, "./tokens.css"), "utf-8");

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
