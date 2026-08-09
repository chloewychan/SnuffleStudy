import { describe, it, expect } from "vitest";
import { PRESSURE_PROFILES, getPressureProfile } from "./pressureProfiles";

describe("pressureProfiles", () => {
  it("seeds exactly the 6 profiles named in the architecture overview", () => {
    const ids = PRESSURE_PROFILES.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        "gentle-encouragement",
        "strict-coach",
        "ruthless-roaster",
        "parent-mode",
        "hype-squad",
        "silent-enforcement",
      ].sort()
    );
  });

  it("gives every profile at least one message in every required pool", () => {
    for (const profile of PRESSURE_PROFILES) {
      expect(profile.firstWarningMessages.length).toBeGreaterThan(0);
      expect(profile.repeatedWarningMessages.length).toBeGreaterThan(0);
      expect(profile.breakMessages.length).toBeGreaterThan(0);
      expect(profile.completionMessages.length).toBeGreaterThan(0);
      expect(profile.abandonmentMessages.length).toBeGreaterThan(0);
    }
  });

  it("returns a profile by id", () => {
    expect(getPressureProfile("strict-coach").name).toBe("Strict Coach");
  });

  it("throws for an unknown profile id", () => {
    expect(() => getPressureProfile("nonexistent")).toThrow("Unknown pressure profile: nonexistent");
  });
});
