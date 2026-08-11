import { describe, it, expect } from "vitest";
import { classifySite, restrictionModeFor } from "./siteRules";
import * as machine from "../session/sessionMachine";
import type { CreateSessionInput } from "../session/sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: ["docs.google.com"],
  restrictedSites: ["youtube.com"],
  restrictionMode: "soft",
  siteRestrictionOverrides: { "reddit.com": "hard" },
};

describe("siteRules", () => {
  const session = machine.createSession(input, "session_1", 0);

  it("classifies an allowed site as ALLOWED", () => {
    expect(classifySite(session, "docs.google.com")).toBe("ALLOWED");
  });

  it("classifies a restricted site as BLOCKED", () => {
    expect(classifySite(session, "youtube.com")).toBe("BLOCKED");
  });

  it("classifies an unlisted site as UNKNOWN", () => {
    expect(classifySite(session, "example.com")).toBe("UNKNOWN");
  });

  it("classifies a null hostname (privileged page) as UNAVAILABLE", () => {
    expect(classifySite(session, null)).toBe("UNAVAILABLE");
  });

  it("resolves restriction mode from the session default", () => {
    expect(restrictionModeFor(session, "youtube.com")).toBe("soft");
  });

  it("resolves restriction mode from a per-site override", () => {
    expect(restrictionModeFor(session, "reddit.com")).toBe("hard");
  });
});
