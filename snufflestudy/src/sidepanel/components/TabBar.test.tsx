import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
  it("renders all four tabs and marks the active one", () => {
    render(<TabBar active="study" onSelect={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Bunny" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Study" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Friends" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "false");
  });

  it("calls onSelect with the clicked tab", () => {
    const onSelect = vi.fn();
    render(<TabBar active="bunny" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("tab", { name: "Friends" }));
    expect(onSelect).toHaveBeenCalledWith("friends");
  });
});
