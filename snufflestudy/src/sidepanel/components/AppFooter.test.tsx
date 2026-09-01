import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { AppFooter } from "./AppFooter";
import { StudyRoomSessionProvider, useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";
import { RefreshRegistryProvider } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as studyRoomApi from "../../infrastructure/backend/studyRoomApi";
import * as videoCallClient from "../../infrastructure/video/videoCallClient";
import type { ExtensionMessage } from "../../shared/messages";
import type { StudyRoom } from "../../domain/rooms/studyRoom";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { FriendRequest } from "../../domain/accountability/friendRequest";
import { getDismissedNudgeIds } from "../../infrastructure/storage/nudgeDismissalState";

// v4.1 Task 7: AppFooter.tsx is the shell this task stands up - for now it renders
// <StudyRoomFooter /> when a room is joined, otherwise null.
// v4.1 Task 8: the shell now also mounts NudgesAndRequestsFooter (via useIncomingActivity(),
// called exactly once, here) once its early-return condition widens to account for the Nudges &
// Unlock Requests half too - see the second describe block below for that coverage.
vi.mock("../../infrastructure/backend/studyRoomApi", () => ({
  joinRoom: vi.fn(),
  subscribeToPresence: vi.fn(),
}));

vi.mock("../../infrastructure/video/videoCallClient", () => ({
  joinCall: vi.fn(),
  leaveCall: vi.fn(),
  onVideoCallEvent: vi.fn(() => () => {}),
  setCameraEnabled: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
}));

const sampleRoom: StudyRoom = {
  id: "room-1",
  name: "Thursday study group",
  ownerUserId: "user-a",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function Harness() {
  const { joinRoom } = useStudyRoomSession();
  return (
    <>
      <button type="button" onClick={() => void joinRoom(sampleRoom, { camera: true, microphone: true })}>
        Join (test harness)
      </button>
      <AppFooter />
    </>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Isolates the dismissed-nudge/tag id set (nudgeDismissalState.ts, chrome.storage.local)
  // between tests - otherwise a dismissal persisted in one test would leak into the next.
  fakeBrowser.reset();
  vi.mocked(studyRoomApi.joinRoom).mockReset().mockResolvedValue({ token: "livekit-jwt" });
  vi.mocked(studyRoomApi.subscribeToPresence).mockReset().mockReturnValue(() => {});
  vi.mocked(videoCallClient.joinCall).mockReset().mockResolvedValue(undefined);
  vi.mocked(videoCallClient.leaveCall).mockReset();
  vi.mocked(videoCallClient.onVideoCallEvent).mockReset().mockReturnValue(() => {});
});

describe("AppFooter", () => {
  it("renders nothing when no study room is joined", () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(
      <RefreshRegistryProvider>
        <StudyRoomSessionProvider>
          <AppFooter />
        </StudyRoomSessionProvider>
      </RefreshRegistryProvider>
    );

    expect(document.querySelector(".sp-app-footer")).not.toBeInTheDocument();
  });

  it("renders the Study Room footer inside .sp-app-footer once a room is joined", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, participants: [] });

    render(
      <RefreshRegistryProvider>
        <StudyRoomSessionProvider>
          <Harness />
        </StudyRoomSessionProvider>
      </RefreshRegistryProvider>
    );

    fireEvent.click(screen.getByText("Join (test harness)"));

    await screen.findByText("Leave Study Room");
    const footer = document.querySelector(".sp-app-footer");
    expect(footer).toBeInTheDocument();
    expect(footer).toContainElement(screen.getByRole("heading", { name: "Thursday study group" }));
  });
});

// v4.1 Task 8: end-to-end coverage of useIncomingActivity() + NudgesAndRequestsFooter, mounted
// through the one real call site (AppFooter.tsx) rather than a crafted-props unit test (that
// coverage lives in NudgesAndRequestsFooter.test.tsx instead) - this is specifically the layer
// where Decision 3 (a persisted dismissed-item id SET, not a single watermark) actually matters:
// only here does dismissing one nudge while an older one is still undismissed get exercised
// against the real nudgeDismissalState.ts persistence, not a mocked dismissNudge().
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    NUDGES_FETCH: () => ({ ok: true, nudges: [] }),
    PRODUCER_TAG_SENDS_FETCH: () => ({ ok: true, sends: [] }),
    FRIEND_REQUESTS_FETCH: () => ({ ok: true, requests: [] }),
    PROFILES_FETCH_BY_IDS: () => ({ ok: true, profiles: [] }),
  };
  return (msg: ExtensionMessage) =>
    Promise.resolve((overrides[msg.type] ?? defaults[msg.type])?.(msg) ?? { ok: true });
}

const olderNudge: FriendNudge = {
  id: "nudge-older",
  senderUserId: "user-friend",
  recipientUserId: "user-self",
  messageId: "keep-going",
  customBody: null,
  sentAt: Date.now() - 10_000,
};

const newerNudge: FriendNudge = {
  id: "nudge-newer",
  senderUserId: "user-friend",
  recipientUserId: "user-self",
  messageId: "you-got-this",
  customBody: null,
  sentAt: Date.now() - 5_000,
};

const pendingRequest: FriendRequest = {
  id: "request-1",
  kind: "site_unlock",
  requesterUserId: "user-friend",
  friendUserId: null,
  message: null,
  status: "pending",
  requestedAt: Date.now(),
  resolvedAt: null,
  resolvedBy: null,
  hostname: "youtube.com",
  sessionId: "session-1",
  expiresAt: null,
};

function renderAppFooter() {
  return render(
    <RefreshRegistryProvider>
      <StudyRoomSessionProvider>
        <AppFooter />
      </StudyRoomSessionProvider>
    </RefreshRegistryProvider>
  );
}

describe("AppFooter — Nudges & Unlock Requests (v4.1 Task 8)", () => {
  it("shows the footer for an undismissed nudge even with no study room joined", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [olderNudge] }) })
    );

    renderAppFooter();

    await waitFor(() => expect(document.querySelector(".sp-app-footer")).toBeInTheDocument());
    expect(screen.getByText(/keep going/)).toBeInTheDocument();
    // No Study Room footer content - nothing joined.
    expect(screen.queryByRole("button", { name: /^leave room$/i })).not.toBeInTheDocument();
  });

  it("dismissing the newer of two nudges leaves the older, still-undismissed one visible (Decision 3)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [olderNudge, newerNudge] }) })
    );

    renderAppFooter();

    await waitFor(() => expect(screen.getByText(/you've got this/i)).toBeInTheDocument());
    expect(screen.getByText(/keep going/)).toBeInTheDocument();

    const dismissButtons = screen.getAllByRole("button", { name: "Dismiss" });
    expect(dismissButtons).toHaveLength(2);
    // Rows are oldest-first - the second row is the newer nudge.
    fireEvent.click(dismissButtons[1]!);

    await waitFor(() => expect(screen.queryByText(/you've got this/i)).not.toBeInTheDocument());
    // The exact case a single watermark couldn't represent: the older nudge is still shown.
    expect(screen.getByText(/keep going/)).toBeInTheDocument();
    expect(document.querySelector(".sp-app-footer")).toBeInTheDocument();
  });

  it("dismissal survives a remount (persisted via chrome.storage.local, not just component state)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [olderNudge] }) })
    );

    const { unmount } = renderAppFooter();
    await waitFor(() => expect(screen.getByText(/keep going/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(document.querySelector(".sp-app-footer")).not.toBeInTheDocument());

    // Waits for the actual chrome.storage.local persistence to complete (not just the optimistic
    // React state update above) before unmounting/remounting - otherwise this test would be racing
    // markNudgeDismissed()'s fire-and-forget write.
    await waitFor(async () => {
      const ids = await getDismissedNudgeIds();
      expect(ids.has("nudge:nudge-older")).toBe(true);
    });

    unmount();
    renderAppFooter();

    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NUDGES_FETCH" })
    ));
    expect(screen.queryByText(/keep going/)).not.toBeInTheDocument();
    expect(document.querySelector(".sp-app-footer")).not.toBeInTheDocument();
  });

  it("approving a pending request resolves it, removes it, and hides the footer once nothing remains", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingRequest] }),
        FRIEND_REQUEST_RESOLVE: () => ({ ok: true }),
      })
    );

    renderAppFooter();

    await waitFor(() => expect(screen.getByText(/wants to unlock youtube\.com/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "FRIEND_REQUEST_RESOLVE",
          payload: { requestId: "request-1", decision: "approved" },
        })
      )
    );
    await waitFor(() =>
      expect(screen.queryByText(/wants to unlock youtube\.com/)).not.toBeInTheDocument()
    );
    expect(document.querySelector(".sp-app-footer")).not.toBeInTheDocument();
  });

  it("denying a pending request resolves it via FRIEND_REQUEST_RESOLVE with decision 'denied'", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUESTS_FETCH: () => ({ ok: true, requests: [pendingRequest] }),
        FRIEND_REQUEST_RESOLVE: () => ({ ok: true }),
      })
    );

    renderAppFooter();

    await waitFor(() => expect(screen.getByText(/wants to unlock youtube\.com/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "FRIEND_REQUEST_RESOLVE",
          payload: { requestId: "request-1", decision: "denied" },
        })
      )
    );
  });

  it("only surfaces pending requests from others, not the viewer's own pending request", async () => {
    const ownRequest: FriendRequest = { ...pendingRequest, id: "request-mine", requesterUserId: "user-self" };
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIEND_REQUESTS_FETCH: () => ({ ok: true, requests: [ownRequest, pendingRequest] }),
      })
    );

    renderAppFooter();

    await waitFor(() => expect(screen.getByText(/wants to unlock youtube\.com/)).toBeInTheDocument());
    // Exactly one row (the friend's), not two - the viewer's own pending request is excluded.
    expect(screen.getAllByText(/wants to unlock youtube\.com/).length).toBe(1);
  });

  it("stays absent when there is nothing pending and no room joined", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    renderAppFooter();

    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NUDGES_FETCH" })
    ));
    expect(document.querySelector(".sp-app-footer")).not.toBeInTheDocument();
  });
});
