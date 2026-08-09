import { describe, it, expect } from "vitest";
import { validateCreateSessionInput } from "./sessionValidation";
import type { CreateSessionInput } from "./sessionTypes";

const validInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("validateCreateSessionInput", () => {
  it("accepts a valid input", () => {
    expect(validateCreateSessionInput(validInput)).toEqual({ valid: true, errors: [] });
  });

  it("rejects an empty goal", () => {
    const result = validateCreateSessionInput({ ...validInput, goal: "   " });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Goal cannot be empty.");
  });

  it("rejects a zero focus duration", () => {
    const result = validateCreateSessionInput({ ...validInput, focusDurationSeconds: 0 });
    expect(result.errors).toContain("Focus duration must be greater than zero.");
  });

  it("rejects a zero break duration", () => {
    const result = validateCreateSessionInput({ ...validInput, breakDurationSeconds: 0 });
    expect(result.errors).toContain("Break duration must be greater than zero.");
  });

  it("rejects a missing pressure profile", () => {
    const result = validateCreateSessionInput({ ...validInput, pressureProfileId: "" });
    expect(result.errors).toContain("A pressure profile must be selected.");
  });

  it("collects multiple errors at once", () => {
    const result = validateCreateSessionInput({
      ...validInput,
      goal: "",
      focusDurationSeconds: 0,
    });
    expect(result.errors).toHaveLength(2);
  });
});
