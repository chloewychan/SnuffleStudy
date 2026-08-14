import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WelcomeScreen } from "./WelcomeScreen";

describe("WelcomeScreen", () => {
  it("explains the product's purpose as consensual peer pressure, not a generic timer", () => {
    render(<WelcomeScreen onContinue={vi.fn()} />);

    expect(screen.getByText(/consensual peer pressure/i)).toBeInTheDocument();
    expect(screen.getByText(/isn't a generic focus timer/i)).toBeInTheDocument();
  });

  it("calls onContinue when the user dismisses the screen", () => {
    const onContinue = vi.fn();
    render(<WelcomeScreen onContinue={onContinue} />);

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(onContinue).toHaveBeenCalled();
  });
});
