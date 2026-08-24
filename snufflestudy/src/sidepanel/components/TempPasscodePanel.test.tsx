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
  codeHash: "",
  codeSalt: "",
  expiresAt: 0,
  failedAttempts: 0,
};

// Mirrors UnlockRequestPanel.test.tsx's routeSendMessage helper exactly.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [] }),
    TEMP_PASSCODE_APPROVE: () => ({ ok: true, code: "483920" }),
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

  it("approving a request reveals the plaintext code, clearly displayed and copyable", async () => {
    const approveSpy = vi.fn(() => ({ ok: true, code: "483920" }));
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
      expect(screen.getByLabelText("Temporary passcode for youtube.com")).toHaveValue("483920")
    );
    expect(approveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TEMP_PASSCODE_APPROVE", payload: { requestId: "temp-1" } })
    );
    // The pending-request list entry for this request is gone once resolved (approved).
    expect(
      screen.queryByText("user-a wants a temporary passcode for youtube.com")
    ).not.toBeInTheDocument();
  });

  it("copying the revealed code writes it to the clipboard and shows confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        TEMP_PASSCODE_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingForMe] }),
        TEMP_PASSCODE_APPROVE: () => ({ ok: true, code: "483920" }),
      })
    );

    render(<TempPasscodePanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("483920"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument());
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
