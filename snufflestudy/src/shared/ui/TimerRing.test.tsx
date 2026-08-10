import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimerRing } from "./TimerRing";

describe("TimerRing", () => {
  it("renders minutes and seconds, zero-padded", () => {
    render(<TimerRing remainingSeconds={125} totalSeconds={1500} />);
    expect(screen.getByRole("timer")).toHaveTextContent("2:05");
  });

  it("renders 0:00 when time has run out", () => {
    render(<TimerRing remainingSeconds={0} totalSeconds={1500} />);
    expect(screen.getByRole("timer")).toHaveTextContent("0:00");
  });
});
