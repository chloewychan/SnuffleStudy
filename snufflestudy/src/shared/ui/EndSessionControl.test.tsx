import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EndSessionControl } from "./EndSessionControl";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";
import type { ExtensionMessage } from "../../shared/messages";
import type { FriendRequest } from "../../domain/accountability/friendRequest";

const softInput: CreateSessionInput = {
  goal: "Finish 20 chemistry problems",
  focusDurationSeconds: 1500,
  breakDurationSeconds: 300,
  pressureProfileId: "strict-coach",
  allowedSites: [],
  restrictedSites: [],
  restrictionMode: "soft",
};

const hardInput: CreateSessionInput = { ...softInput, restrictionMode: "hard" };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("EndSessionControl", () => {
  it("ends a soft-mode session immediately on a single click, with no passcode prompt", async () => {
    const session = machine.startSession(machine.createSession(softInput, "session_1", 0), 0);
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, session: null });

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_END",
        payload: { sessionId: "session_1" },
      })
    );
    expect(screen.queryByPlaceholderText("Passcode")).not.toBeInTheDocument();
  });

  it("reveals an inline passcode prompt instead of sending immediately for a hard-mode session", () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    // v3.4 Task 3: opening the prompt now also triggers the requester-side friend picker's own
    // FRIENDS_LIST fetch (this test's own assertion below is only about SESSION_END never firing
    // on prompt-open, not about sendMessage being called zero times overall).
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));

    expect(screen.getByPlaceholderText("Passcode")).toBeInTheDocument();
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_END" })
    );
  });

  it("ends the hard-mode session when the correct passcode is submitted", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, session: null });

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_END",
        payload: { sessionId: "session_1", passcode: "1234" },
      })
    );
  });

  it("shows an error and keeps the prompt open when the passcode is incorrect, leaving the session active", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    // v3.4 Task 3: routed by type - FRIENDS_LIST (the friend picker's own fetch, triggered by
    // opening the prompt) must resolve cleanly here, or its own "Couldn't load your friends"
    // alert would collide with this test's own passcode-error alert assertion below.
    vi.spyOn(messenger, "sendMessage").mockImplementation(((msg: ExtensionMessage) => {
      if (msg.type === "FRIENDS_LIST") return Promise.resolve({ ok: true, friendIds: [] });
      return Promise.resolve({
        ok: false,
        error: "Incorrect passcode, or temporarily locked after repeated attempts.",
      });
    }) as never);

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Incorrect passcode/);
    // The prompt is still showing (i.e. the control never treated the session as ended).
    expect(screen.getByPlaceholderText("Passcode")).toBeInTheDocument();
  });

  it("shows an error and does not leave an unhandled rejection when the passcode sendMessage call rejects", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    // v3.4 Task 3: routed by type, same rationale as the incorrect-passcode test above - the
    // friend picker's own FRIENDS_LIST fetch must not itself reject, or its own caught error
    // would produce a second, colliding alert.
    vi.spyOn(messenger, "sendMessage").mockImplementation(((msg: ExtensionMessage) => {
      if (msg.type === "FRIENDS_LIST") return Promise.resolve({ ok: true, friendIds: [] });
      return Promise.reject(
        new Error("Could not establish connection. Receiving end does not exist.")
      );
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("disables the submit button and shows a loading label while the passcode request is in flight", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    let resolvePromise: (value: { ok: boolean }) => void = () => {};
    vi.spyOn(messenger, "sendMessage").mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }) as ReturnType<typeof messenger.sendMessage>
    );

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.change(screen.getByPlaceholderText("Passcode"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));

    const submitButton = await screen.findByRole("button", { name: "Checking…" });
    expect(submitButton).toBeDisabled();

    resolvePromise({ ok: true });
    // Submitting reverts once the request settles (a real successful end also causes the
    // parent's active-session subscription to swap this whole view out, but that's outside
    // this component's own responsibility/test scope).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm end session" })).not.toBeDisabled()
    );
  });
});

// v3.3 Task 12: the temporary-pass path, alongside (never instead of) the permanent-passcode
// form above - the tests above already cover that the passcode form itself is unaffected by any
// of this. Mirrors LockedPage.test.tsx's routeSendMessage-by-type helper convention, since this
// component now sends several distinct message types.
//
// v3.4 Task 3: FRIEND_REQUEST_CREATE("session_end", ...)/FRIEND_REQUESTS_FETCH replace
// SESSION_END_REQUEST_CREATE/SESSION_END_REQUESTS_FETCH, and this form gained a friend picker
// (FRIENDS_LIST) that must resolve before "Request a temporary pass from a friend" becomes
// clickable - every test below mocks FRIENDS_LIST with at least one friend and waits for the
// button to become enabled before clicking it, mirroring LockedPage.test.tsx's own friend-picker
// wait pattern.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type];
    if (handler) return Promise.resolve(handler(msg));
    if (msg.type === "FRIENDS_LIST") return Promise.resolve({ ok: true, friendIds: ["user-b"] });
    return Promise.resolve({ ok: true });
  };
}

function sampleEndRequest(overrides: Partial<FriendRequest> = {}): FriendRequest {
  return {
    id: "end-req-1",
    kind: "session_end",
    sessionId: "session_1",
    requesterUserId: "user-a",
    friendUserId: "user-b",
    message: null,
    hostname: null,
    status: "pending",
    requestedAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: null,
    ...overrides,
  };
}

async function requestButton() {
  return waitFor(() => {
    const button = screen.getByRole("button", { name: "Request a temporary pass from a friend" });
    expect(button).not.toBeDisabled();
    return button;
  });
}

describe("EndSessionControl — temporary pass to end a hard-restricted session early (v3.3 Task 12)", () => {
  it("shows a 'Request a temporary pass from a friend' button alongside the unchanged passcode form, enabled once a friend loads", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}) as never);

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));

    expect(screen.getByPlaceholderText("Passcode")).toBeInTheDocument();
    expect(await requestButton()).toBeInTheDocument();
  });

  it("requests a temporary pass for the picked friend, shows Pending status, then Check status refreshes it", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    const pending = sampleEndRequest({ status: "pending" });
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUEST_CREATE: (msg) => {
          expect(
            (msg as { payload: { kind: string; sessionId: string; friendUserId: string } }).payload
          ).toEqual({ kind: "session_end", sessionId: "session_1", friendUserId: "user-b" });
          return { ok: true, request: pending };
        },
        FRIEND_REQUESTS_FETCH: () => ({ ok: true, requests: [{ ...pending, status: "approved" }] }),
      }) as never
    );

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.click(await requestButton());

    await waitFor(() => expect(screen.getByText("Pending")).toBeInTheDocument());
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "FRIEND_REQUEST_CREATE",
      payload: { kind: "session_end", sessionId: "session_1", friendUserId: "user-b" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));

    await waitFor(() => expect(screen.getByText("Approved")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "End session now" })).toBeInTheDocument();
  });

  it("ends the session via the approved pass, without ever entering a passcode", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    const approved = sampleEndRequest({ status: "approved" });
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUEST_CREATE: () => ({ ok: true, request: approved }),
        SESSION_END: (msg) => {
          expect((msg as { payload: { endRequestId?: string; passcode?: string } }).payload).toEqual({
            sessionId: "session_1",
            endRequestId: "end-req-1",
          });
          return { ok: true, session: null };
        },
      }) as never
    );

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.click(await requestButton());

    await waitFor(() => expect(screen.getByRole("button", { name: "End session now" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "End session now" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "SESSION_END",
        payload: { sessionId: "session_1", endRequestId: "end-req-1" },
      })
    );
  });

  it("shows Denied and an Ask again button when the request is denied, leaving the passcode path as the only way through", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    const denied = sampleEndRequest({ status: "denied" });
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUEST_CREATE: () => ({ ok: true, request: denied }),
      }) as never
    );

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.click(await requestButton());

    await waitFor(() => expect(screen.getByText("Denied")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Ask again" })).toBeInTheDocument();
    // The permanent-passcode form is still right there, untouched.
    expect(screen.getByPlaceholderText("Passcode")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(await requestButton()).toBeInTheDocument();
  });

  it("surfaces an inline error, not an unhandled rejection, when creating the request fails", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUEST_CREATE: () => ({ ok: false, error: "No friends available to ask." }),
      }) as never
    );

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.click(await requestButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("No friends available to ask.");
  });

  it("does NOT end the session, and shows the server's error, when SESSION_END rejects an endRequestId (e.g. the negative case - the resolving friend's own id was not the requester)", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    const approved = sampleEndRequest({ status: "approved" });
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUEST_CREATE: () => ({ ok: true, request: approved }),
        SESSION_END: () => ({
          ok: false,
          error: "That temporary pass isn't valid for this session, or hasn't been approved yet.",
        }),
      }) as never
    );

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));
    fireEvent.click(await requestButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "End session now" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "End session now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't valid for this session/);
    // Still on the prompt view - the session was NOT ended.
    expect(screen.getByRole("button", { name: "End session now" })).toBeInTheDocument();
  });

  it("does not enable the request button, and shows a message, when there are no friends to ask", async () => {
    const session = machine.startSession(machine.createSession(hardInput, "session_1", 0), 0);
    vi.spyOn(messenger, "sendMessage").mockImplementation(((msg: ExtensionMessage) => {
      if (msg.type === "FRIENDS_LIST") return Promise.resolve({ ok: true, friendIds: [] });
      return Promise.resolve({ ok: true });
    }) as never);

    render(<EndSessionControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "End Session" }));

    expect(await screen.findByText("No friends available to ask yet - add a friend first.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Request a temporary pass from a friend" })
    ).toBeDisabled();
  });
});
