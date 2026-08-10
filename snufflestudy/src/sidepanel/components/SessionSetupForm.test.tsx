import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionSetupForm } from "./SessionSetupForm";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SessionSetupForm", () => {
  it("creates and starts a session on submit", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValueOnce({ ok: true, session: { id: "session_1" } })
      .mockResolvedValueOnce({ ok: true });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);

    fireEvent.change(screen.getByPlaceholderText("Finish 20 chemistry problems"), {
      target: { value: "Read chapter 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: "SESSION_CREATE",
          payload: expect.objectContaining({ goal: "Read chapter 3" }),
        })
      )
    );
    expect(sendMessageSpy).toHaveBeenNthCalledWith(2, {
      type: "SESSION_START",
      payload: { sessionId: "session_1" },
    });
  });

  it("shows validation errors instead of starting a session", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValueOnce({
      ok: false,
      errors: ["Goal cannot be empty."],
    });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Goal cannot be empty."));
  });

  it("surfaces an error and does not crash when sendMessage rejects", async () => {
    // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
    // connection. Receiving end does not exist." during service-worker startup races,
    // or extension-context-invalidated. The submit handler must catch it instead of
    // throwing from the form's onSubmit handler and leaving the button doing nothing.
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledTimes(1));

    // (a) no unhandled rejection surfaces / component doesn't crash — implied by these
    // assertions succeeding, since vitest fails the test on unhandled rejections.
    // (b) an error indication is visible to the user via the existing alert mechanism.
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);

    // (c) the button is still present and usable — the form survived the rejection.
    expect(screen.getByRole("button", { name: "Start session" })).toBeInTheDocument();
  });
});
