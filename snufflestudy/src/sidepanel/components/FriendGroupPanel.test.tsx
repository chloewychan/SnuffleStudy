import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FriendGroupPanel } from "./FriendGroupPanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { FriendEvent } from "../../infrastructure/backend/sessionStatusSyncApi";

beforeEach(() => {
  vi.restoreAllMocks();
});

const sampleEvent: FriendEvent = {
  id: "event-1",
  userId: "user-a",
  sessionId: "session-1",
  type: "SESSION_STARTED",
  displayLabel: "started a focus session",
  occurredAt: new Date("2026-01-01T12:00:00Z").getTime(),
};

describe("FriendGroupPanel", () => {
  it("fetches friend events on mount via FRIEND_EVENTS_FETCH and renders them", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, events: [sampleEvent] });

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "FRIEND_EVENTS_FETCH",
        payload: { sinceTimestamp: expect.any(Number) },
      })
    );
    await waitFor(() => expect(screen.getByText("started a focus session")).toBeInTheDocument());
    expect(screen.getByText(/user-a/)).toBeInTheDocument();
  });

  it("shows a no-activity message when there are no events", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, events: [] });

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("No recent friend activity.")).toBeInTheDocument());
  });

  it("shows an error message when the fetch response is ok:false", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: false, error: "Not signed in." });

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not signed in."));
  });

  it("surfaces an error and does not crash when sendMessage rejects", async () => {
    // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
    // connection. Receiving end does not exist." during service-worker startup races, or
    // extension-context-invalidated.
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("connection lost"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("connection lost"));
  });

  it("refetches when the Refresh button is clicked", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, events: [] });

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledTimes(2));
  });

  it("calls onClose when Close is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, events: [] });
    const onClose = vi.fn();

    render(<FriendGroupPanel onClose={onClose} />);
    await waitFor(() => screen.getByText("No recent friend activity."));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });
});
