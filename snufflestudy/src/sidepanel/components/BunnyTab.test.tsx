import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BunnyTab } from "./BunnyTab";

describe("BunnyTab", () => {
  it("renders editable name fields with defaults", () => {
    render(<BunnyTab />);
    expect(screen.getByLabelText(/bunny name/i)).toHaveValue("Snuffles");
    expect(screen.getByLabelText(/human name/i)).toHaveValue("Hooman");
  });

  it("updates name fields when typed", () => {
    render(<BunnyTab />);
    const bunnyInput = screen.getByLabelText(/bunny name/i);
    const humanInput = screen.getByLabelText(/human name/i);

    fireEvent.change(bunnyInput, { target: { value: "Fluffball" } });
    fireEvent.change(humanInput, { target: { value: "Alice" } });

    expect(bunnyInput).toHaveValue("Fluffball");
    expect(humanInput).toHaveValue("Alice");
  });

  it("toggles Show Bunny", () => {
    render(<BunnyTab />);
    const toggle = screen.getByRole("checkbox", { name: /show bunny/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  it("renders the three status meters", () => {
    render(<BunnyTab />);
    expect(screen.getByText(/happiness/i)).toBeInTheDocument();
    expect(screen.getByText(/productivity/i)).toBeInTheDocument();
    expect(screen.getByText(/friendliness/i)).toBeInTheDocument();
  });
});
