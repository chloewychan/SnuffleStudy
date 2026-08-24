import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BunnyTab } from "./BunnyTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { ExtensionMessage } from "../../shared/messages";
import type { Profile } from "../../infrastructure/backend/profileApi";

beforeEach(() => {
  vi.restoreAllMocks();
});

// v3.3 Task 8: mirrors this codebase's established routeSendMessage helper convention
// (UnlockRequestPanel.test.tsx/TempPasscodePanel.test.tsx/StudyRoomPanel.test.tsx) - lets each
// test override only the message types it cares about; PROFILE_GET_MINE defaults to "no profile
// row yet" so every pre-existing (pre-Task-8) test below keeps exercising exactly the stub-default
// behavior it did before, without each test having to know this component now fetches on mount.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    PROFILE_GET_MINE: () => ({ ok: true, profile: null }),
    PROFILE_SAVE_MINE: () => ({ ok: true }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

function mockMessages(overrides: Partial<Record<ExtensionMessage["type"], Handler>> = {}) {
  return vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage(overrides) as never);
}

describe("BunnyTab", () => {
  it("renders editable name fields with the stub defaults when no profile row exists yet", async () => {
    mockMessages();
    render(<BunnyTab />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(screen.getByLabelText(/bunny name/i)).toHaveValue("Snuffles");
    expect(screen.getByLabelText(/human name/i)).toHaveValue("Hooman");
  });

  it("updates name fields when typed", async () => {
    mockMessages();
    render(<BunnyTab />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    const bunnyInput = screen.getByLabelText(/bunny name/i);
    const humanInput = screen.getByLabelText(/human name/i);

    fireEvent.change(bunnyInput, { target: { value: "Fluffball" } });
    fireEvent.change(humanInput, { target: { value: "Alice" } });

    expect(bunnyInput).toHaveValue("Fluffball");
    expect(humanInput).toHaveValue("Alice");
  });

  it("toggles Show Bunny", async () => {
    mockMessages();
    render(<BunnyTab />);
    const toggle = screen.getByRole("checkbox", { name: /show bunny/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  it("renders the three status meters", async () => {
    mockMessages();
    render(<BunnyTab />);
    expect(screen.getByText(/happiness/i)).toBeInTheDocument();
    expect(screen.getByText(/productivity/i)).toBeInTheDocument();
    expect(screen.getByText(/friendliness/i)).toBeInTheDocument();
  });

  // v3.3 Task 8: the DoD's "reloading shows the saved name, not reset to the stub default" -
  // exercised here as "a fresh mount with an existing profiles row shows the saved values", since
  // a page reload is, from this component's own point of view, just another fresh mount.
  it("loads a previously saved bunny/human name from PROFILE_GET_MINE instead of the stub defaults", async () => {
    const savedProfile: Profile = {
      userId: "user-a",
      bunnyName: "Fluffball",
      humanName: "Alice",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockMessages({ PROFILE_GET_MINE: () => ({ ok: true, profile: savedProfile }) });
    render(<BunnyTab />);

    await waitFor(() => expect(screen.getByLabelText(/bunny name/i)).toHaveValue("Fluffball"));
    expect(screen.getByLabelText(/human name/i)).toHaveValue("Alice");
  });

  it("saves the current field values via PROFILE_SAVE_MINE when Save is clicked", async () => {
    const sendMessageSpy = mockMessages();
    render(<BunnyTab />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText(/bunny name/i), { target: { value: "Fluffball" } });
    fireEvent.change(screen.getByLabelText(/human name/i), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "PROFILE_SAVE_MINE",
        payload: { humanName: "Alice", bunnyName: "Fluffball" },
      })
    );
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
  });

  it("shows an error inline when PROFILE_SAVE_MINE fails, without crashing", async () => {
    mockMessages({ PROFILE_SAVE_MINE: () => ({ ok: false, error: "Not signed in." }) });
    render(<BunnyTab />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not signed in."));
  });
});
