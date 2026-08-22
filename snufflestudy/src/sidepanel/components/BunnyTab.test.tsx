import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BunnyTab } from "./BunnyTab";

describe("BunnyTab", () => {
  it("renders editable name fields with defaults", () => {
    render(<BunnyTab />);
    expect(screen.getByLabelText(/bunny name/i)).toHaveValue("Snuffles");
    expect(screen.getByLabelText(/human name/i)).toHaveValue("Hooman");
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
