import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TempPasscodePanel } from "./TempPasscodePanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { ExtensionMessage } from "../../shared/messages";
import type { TempPasscodeRequest } from "../../domain/accountability/tempPasscodeRequest";

beforeEach(() => {
  vi.restoreAllMocks();
});

const pendingForMe: TempPasscodeRequest = {
  id: "temp-1",
  sessionId: "session-1",
  hostname: "youtube.com",
  friendUserId: "user-self",
  requesterUserId: "user-a",
  status: "pending",
  expiresAt: 0,
  message: null,
};

// Mirrors UnlockRequestPanel.test.tsx's routeSendMessage helper exactly.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [] }),
    TEMP_PASSCODE_APPROVE: () => ({ ok: true }),
    TEMP_PASSCODE_DENY: () => ({ ok: true }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

describe("TempPasscodePanel", () => {
  it("shows a pending request addressed to the current user, with Approve/Deny actions", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingForMe] }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("user-a wants a temporary passcode for youtube.com")).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  // v3.3 Task 11: a request created WITH a message shows it to the approving friend.
  it("shows the requester's message when present", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [{ ...pendingForMe, message: "Need to check the class syllabus" }],
        }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText('"Need to check the class syllabus"')).toBeInTheDocument()
    );
  });

  // v3.3 Task 11 DoD: a request created WITHOUT one (the field is optional) renders exactly as it
  // does today - no empty placeholder text of any kind.
  it("renders no message placeholder when the request has none", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingForMe] }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("user-a wants a temporary passcode for youtube.com")).toBeInTheDocument()
    );
    expect(document.querySelector(".temp-passcode-panel__message")).not.toBeInTheDocument();
  });

  it("does not show a request addressed to someone else (friendUserId mismatch)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [{ ...pendingForMe, friendUserId: "someone-else" }],
        }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("No pending temporary passcode requests.")).toBeInTheDocument());
  });

  it("does not show a request that isn't pending", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({
          ok: true,
          requests: [{ ...pendingForMe, status: "denied" }],
        }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("No pending temporary passcode requests.")).toBeInTheDocument());
  });

  // v3.3 Task 10: approving no longer returns or reveals a code - the request simply leaves the
  // pending list once approved, no further UI needed on the approver's side.
  it("approving a request removes it from the pending list, with no code shown anywhere", async () => {
    const approveSpy = vi.fn(() => ({ ok: true }));
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingForMe] }),
        TEMP_PASSCODE_APPROVE: approveSpy,
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.queryByText("user-a wants a temporary passcode for youtube.com")
      ).not.toBeInTheDocument()
    );
    expect(approveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TEMP_PASSCODE_APPROVE", payload: { requestId: "temp-1" } })
    );
    // No code UI of any kind - "Codes to relay to your friend" section is gone entirely.
    expect(screen.queryByText("Codes to relay to your friend")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("shows a server-side rejection when approving fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingForMe] }),
        TEMP_PASSCODE_APPROVE: () => ({ ok: false, error: "Request is already denied, not pending" }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByText("Request is already denied, not pending")).toBeInTheDocument()
    );
    // Still listed as pending - approval failed, so it wasn't optimistically removed.
    expect(
      screen.getByText("user-a wants a temporary passcode for youtube.com")
    ).toBeInTheDocument();
  });

  it("denying a request removes it from the pending list", async () => {
    const denySpy = vi.fn(() => ({ ok: true }));
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingForMe] }),
        TEMP_PASSCODE_DENY: denySpy,
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(
        screen.queryByText("user-a wants a temporary passcode for youtube.com")
      ).not.toBeInTheDocument()
    );
    expect(denySpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TEMP_PASSCODE_DENY", payload: { requestId: "temp-1" } })
    );
  });

  it("shows a server-side rejection (e.g. already resolved) inline and refreshes the list", async () => {
    const fetchSpy = vi.fn(() => ({ ok: true, requests: [pendingForMe] }));
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: fetchSpy,
        TEMP_PASSCODE_DENY: () => ({ ok: false, error: "already have been resolved" }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText("already have been resolved")).toBeInTheDocument());
    // loadRequests() is called again on a failed resolve, refreshing the (now-stale) list.
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("calls onClose when the Close button is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));
    const onClose = vi.fn();

    render(<TempPasscodePanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });
});

// v3.2 Task 2: signed out, this panel used to silently show "No pending temporary passcode
// requests." (TEMP_PASSCODE_REQUESTS_FETCH degrades to [] when signed out, per messageRouter.ts) -
// indistinguishable from actually having zero pending requests. This now shows an inline sign-in
// prompt instead, in the same "Requests from friends" section.
describe("TempPasscodePanel — signed-out gate (v3.2 Task 2)", () => {
  it("shows an inline sign-in prompt in the friends section when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    render(<TempPasscodePanel onClose={() => {}} />);

    expect(
      await screen.findByText("Sign in to see or approve temporary passcode requests from friends.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText("No pending temporary passcode requests.")).not.toBeInTheDocument();
  });

  it("does not show the sign-in prompt while sign-in status is still loading", async () => {
    let resolveSelf: (value: unknown) => void = () => {};
    const selfPromise = new Promise((resolve) => {
      resolveSelf = resolve;
    });
    vi.spyOn(messenger, "sendMessage").mockImplementation((msg: ExtensionMessage) => {
      if (msg.type === "AUTH_GET_SESSION") return selfPromise as Promise<unknown>;
      return routeSendMessage({})(msg);
    });

    render(<TempPasscodePanel onClose={() => {}} />);

    await screen.findByText("No pending temporary passcode requests.");
    expect(
      screen.queryByText("Sign in to see or approve temporary passcode requests from friends.")
    ).not.toBeInTheDocument();

    resolveSelf({ ok: true, session: { user: { id: "user-self" } } });
    await waitFor(() =>
      expect(
        screen.queryByText("Sign in to see or approve temporary passcode requests from friends.")
      ).not.toBeInTheDocument()
    );
  });
});
