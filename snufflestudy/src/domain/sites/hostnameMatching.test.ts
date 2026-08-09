import { describe, it, expect } from "vitest";
import { isHostnameInList } from "./hostnameMatching";

describe("isHostnameInList", () => {
  it("matches an exact hostname", () => {
    expect(isHostnameInList("youtube.com", ["youtube.com"])).toBe(true);
  });

  it("matches a subdomain of a listed hostname", () => {
    expect(isHostnameInList("m.youtube.com", ["youtube.com"])).toBe(true);
  });

  it("does not match an unrelated hostname", () => {
    expect(isHostnameInList("youtube.com.evil.example", ["youtube.com"])).toBe(false);
  });

  it("does not match a hostname that merely contains the listed string", () => {
    expect(isHostnameInList("notyoutube.com", ["youtube.com"])).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(isHostnameInList("youtube.com", [])).toBe(false);
  });
});
