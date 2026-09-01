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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save bunny name" })).not.toBeDisabled()
    );
    expect(screen.getByLabelText("Bunny Name:")).toHaveValue("Snuffles");
    expect(screen.getByLabelText("Human Name:")).toHaveValue("Hooman");
  });

  it("updates name fields when typed", async () => {
    mockMessages();
    render(<BunnyTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save bunny name" })).not.toBeDisabled()
    );
    const bunnyInput = screen.getByLabelText("Bunny Name:");
    const humanInput = screen.getByLabelText("Human Name:");

    fireEvent.change(bunnyInput, { target: { value: "Fluffball" } });
    fireEvent.change(humanInput, { target: { value: "Alice" } });

    expect(bunnyInput).toHaveValue("Fluffball");
    expect(humanInput).toHaveValue("Alice");
  });

  it("has no Show Bunny toggle or Status meters (removed in v4.1 Task 5)", async () => {
    mockMessages();
    render(<BunnyTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save bunny name" })).not.toBeDisabled()
    );
    expect(screen.queryByRole("checkbox", { name: /show bunny/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/happiness/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/productivity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/friendliness/i)).not.toBeInTheDocument();
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
      passwordSetAt: null,
    };
    mockMessages({ PROFILE_GET_MINE: () => ({ ok: true, profile: savedProfile }) });
    render(<BunnyTab />);

    await waitFor(() => expect(screen.getByLabelText("Bunny Name:")).toHaveValue("Fluffball"));
    expect(screen.getByLabelText("Human Name:")).toHaveValue("Alice");
  });

  it("saves the current field values via PROFILE_SAVE_MINE when Save bunny name is clicked", async () => {
    const sendMessageSpy = mockMessages();
    render(<BunnyTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save bunny name" })).not.toBeDisabled()
    );

    fireEvent.change(screen.getByLabelText("Bunny Name:"), { target: { value: "Fluffball" } });
    fireEvent.change(screen.getByLabelText("Human Name:"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save bunny name" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "PROFILE_SAVE_MINE",
        payload: { humanName: "Alice", bunnyName: "Fluffball" },
      })
    );
    await waitFor(() => expect(screen.getAllByText("Saved.")).toHaveLength(1));
  });

  it("saves the current field values via PROFILE_SAVE_MINE when Save human name is clicked", async () => {
    const sendMessageSpy = mockMessages();
    render(<BunnyTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save human name" })).not.toBeDisabled()
    );

    fireEvent.change(screen.getByLabelText("Bunny Name:"), { target: { value: "Fluffball" } });
    fireEvent.change(screen.getByLabelText("Human Name:"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save human name" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "PROFILE_SAVE_MINE",
        payload: { humanName: "Alice", bunnyName: "Fluffball" },
      })
    );
    await waitFor(() => expect(screen.getAllByText("Saved.")).toHaveLength(1));
  });

  it("shows an error inline when PROFILE_SAVE_MINE fails for Save bunny name, without crashing", async () => {
    mockMessages({ PROFILE_SAVE_MINE: () => ({ ok: false, error: "Not signed in." }) });
    render(<BunnyTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save bunny name" })).not.toBeDisabled()
    );

    fireEvent.click(screen.getByRole("button", { name: "Save bunny name" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not signed in."));
  });

  it("shows an error inline when PROFILE_SAVE_MINE fails for Save human name, without crashing", async () => {
    mockMessages({ PROFILE_SAVE_MINE: () => ({ ok: false, error: "Not signed in." }) });
    render(<BunnyTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save human name" })).not.toBeDisabled()
    );

    fireEvent.click(screen.getByRole("button", { name: "Save human name" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not signed in."));
  });

  // v4.1 Task 5: the two Save buttons must own fully independent saving/success state - clicking
  // one must never flip the other's button label to "Saving...", and a slow bunny-name save must
  // not block or delay the human-name save's own success state.
  it("keeps the two Save buttons' loading/success state independent", async () => {
    let resolveBunnySave!: (value: { ok: boolean }) => void;
    const bunnySavePromise = new Promise<{ ok: boolean }>((resolve) => {
      resolveBunnySave = resolve;
    });

    let saveCallCount = 0;
    mockMessages({
      PROFILE_SAVE_MINE: () => {
        saveCallCount += 1;
        // First call (Save bunny name) hangs until we resolve it manually; every subsequent call
        // (Save human name) resolves immediately, simulating the human-name save finishing first.
        return saveCallCount === 1 ? bunnySavePromise : Promise.resolve({ ok: true });
      },
    });

    render(<BunnyTab />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save bunny name" })).not.toBeDisabled()
    );

    fireEvent.click(screen.getByRole("button", { name: "Save bunny name" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving bunny name…" })).toBeInTheDocument());

    // The human name button must still read its own idle label, not "Saving...", while the bunny
    // name save is still in flight.
    expect(screen.getByRole("button", { name: "Save human name" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save human name" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());

    // The human name save resolved and shows "Saved." (its button is idle again) while the bunny
    // name save is still pending - the bunny button must still read "Saving...", unaffected by the
    // human name save completing.
    expect(screen.getByRole("button", { name: "Saving bunny name…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save human name" })).toBeInTheDocument();

    resolveBunnySave({ ok: true });
    await waitFor(() => expect(screen.getAllByText("Saved.")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Save bunny name" })).toBeInTheDocument();
  });
});
