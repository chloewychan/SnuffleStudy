import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionStatusCard } from "./SessionStatusCard";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";

const input: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

describe("SessionStatusCard", () => {
  it("shows the goal and state", () => {
    const session = machine.startSession(machine.createSession(input, "session_1", 0), 0);
    render(<SessionStatusCard session={session} />);
    expect(screen.getByText("Finish 20 chemistry problems")).toBeInTheDocument();
    expect(screen.getByText("FOCUSING")).toBeInTheDocument();
  });

  it("hides the distraction count when there are none", () => {
    const session = machine.createSession(input, "session_1", 0);
    render(<SessionStatusCard session={session} />);
    expect(screen.queryByText(/distraction attempt/)).not.toBeInTheDocument();
  });

  it("shows a pluralized distraction count when there are some", () => {
    const session = machine.recordDistractionAttempt(machine.createSession(input, "session_1", 0));
    render(<SessionStatusCard session={session} />);
    expect(screen.getByText("1 distraction attempt")).toBeInTheDocument();
  });
});
