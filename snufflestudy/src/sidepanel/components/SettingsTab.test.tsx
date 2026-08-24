import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SettingsTab } from "./SettingsTab";

describe("SettingsTab", () => {
  it("renders an empty placeholder (v3.3 Task 1: content moved to FriendsTab; Task 7 rebuilds this tab)", () => {
    const { container } = render(<SettingsTab />);

    const root = container.querySelector(".sp-tab-content.sp-settings-tab");
    expect(root).toBeInTheDocument();
    expect(root).toBeEmptyDOMElement();
  });
});
