import { describe, it, expect } from "vitest";
import { currentHostname } from "./siteContext";

describe("currentHostname", () => {
  it("returns window.location.hostname", () => {
    expect(currentHostname()).toBe(window.location.hostname);
  });
});
