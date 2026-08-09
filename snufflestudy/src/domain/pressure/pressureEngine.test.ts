import { describe, it, expect } from "vitest";
import { pickWarningMessage } from "./pressureEngine";
import { getPressureProfile } from "./pressureProfiles";

describe("pressureEngine", () => {
  it("picks a message from firstWarningMessages when interventionLevel is 'warned'", () => {
    const profile = getPressureProfile("strict-coach");
    const message = pickWarningMessage("strict-coach", "warned");
    expect(profile.firstWarningMessages).toContain(message);
  });

  it("picks a message from repeatedWarningMessages when interventionLevel is 'escalated'", () => {
    const profile = getPressureProfile("strict-coach");
    const message = pickWarningMessage("strict-coach", "escalated");
    expect(profile.repeatedWarningMessages).toContain(message);
  });
});
