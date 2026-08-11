import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LockedPage } from "./LockedPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/locked.html?site=youtube.com");
});

describe("LockedPage", () => {
  it("shows the restricted hostname from the query string", () => {
    render(<LockedPage />);
    expect(screen.getByText(/youtube.com is hard-restricted/)).toBeInTheDocument();
  });

  it("shows an error on an incorrect passcode", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: false });
    render(<LockedPage />);

    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("navigates to the site on a correct passcode", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });
    delete (window as any).location;
    (window as any).location = { href: "" };

    render(<LockedPage />);
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(window.location.href).toBe("https://youtube.com"));
  });
});
