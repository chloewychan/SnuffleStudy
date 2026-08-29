import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NudgesAndRequestsFooter } from "./NudgesAndRequestsFooter";
import { RefreshRegistryProvider, useRefreshAll } from "../refresh/RefreshRegistryContext";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";
import type { IncomingActivity } from "../appFooter/useIncomingActivity";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { IncomingProducerTag } from "../../infrastructure/backend/producerTagApi";
import type { FriendRequest } from "../../domain/accountability/friendRequest";

// v4.1 Task 8: unit-level coverage for the presentation half of the Nudges & Unlock Requests
// footer - IncomingActivity's data/handlers are supplied as plain props here (this component
// itself owns no fetches beyond the lazy per-item audio download), so every case below constructs
// its own crafted activity object rather than exercising useIncomingActivity.ts's real fetch/poll
// machinery - that's covered end to end via AppFooter.test.tsx instead (the only real call site,
// per useIncomingActivity.ts's own "instantiated once, inside AppFooter" contract).
vi.mock("../../infrastructure/backend/producerTagApi", () => ({
  downloadTagAudio: vi.fn(),
}));

function makeActivity(overrides: Partial<IncomingActivity> = {}): IncomingActivity {
  return {
    nudges: [],
    nudgesError: null,
    incomingTags: [],
    tagsError: null,
    requests: [],
    requestsError: null,
    resolvingRequestId: null,
    resolveError: null,
    dismissNudge: vi.fn(),
    dismissTag: vi.fn(),
    resolveRequest: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

const sampleNudge: FriendNudge = {
  id: "nudge-1",
  senderUserId: "user-friend",
  recipientUserId: "user-self",
  messageId: "keep-going",
  customBody: null,
  sentAt: Date.now() - 2000,
};

const sampleTag: IncomingProducerTag = {
  tagId: "tag-1",
  senderUserId: "user-friend",
  sentAt: Date.now() - 1000,
  audioUrl: "tag-1/clip.webm",
  durationMs: 4200,
};

const sampleRequest: FriendRequest = {
  id: "request-1",
  kind: "site_unlock",
  requesterUserId: "user-friend",
  friendUserId: null,
  message: "please, I need youtube for research",
  status: "pending",
  requestedAt: Date.now(),
  resolvedAt: null,
  resolvedBy: null,
  hostname: "youtube.com",
  sessionId: "session-1",
  expiresAt: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, profiles: [] });
  vi.mocked(producerTagApi.downloadTagAudio).mockReset();
});

function renderFooter(activity: IncomingActivity) {
  return render(
    <RefreshRegistryProvider>
      <NudgesAndRequestsFooter {...activity} />
    </RefreshRegistryProvider>
  );
}

describe("NudgesAndRequestsFooter", () => {
  it("renders a written nudge's sender and text, with a working Dismiss button", async () => {
    const dismissNudge = vi.fn();
    renderFooter(makeActivity({ nudges: [sampleNudge], dismissNudge }));

    await waitFor(() =>
      expect(screen.getByText(/Thinking of you — keep going!/)).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissNudge).toHaveBeenCalledWith("nudge-1");
  });

  it("falls back to a generic message for an unrecognized messageId, and to customBody when set", async () => {
    const customNudge: FriendNudge = { ...sampleNudge, id: "nudge-2", customBody: "Hang in there!" };
    const unknownNudge: FriendNudge = { ...sampleNudge, id: "nudge-3", messageId: "not-a-real-id" };
    renderFooter(makeActivity({ nudges: [customNudge, unknownNudge] }));

    await waitFor(() => expect(screen.getByText(/Hang in there!/)).toBeInTheDocument());
    expect(screen.getByText(/sent you a nudge\./)).toBeInTheDocument();
  });

  it("lazily downloads and plays an incoming audio nudge only once Play is pressed, with a working Dismiss", async () => {
    vi.mocked(producerTagApi.downloadTagAudio).mockResolvedValue(new Blob(["audio-bytes"]));
    const dismissTag = vi.fn();
    renderFooter(makeActivity({ incomingTags: [sampleTag], dismissTag }));

    await waitFor(() => expect(screen.getByText(/4s audio nudge/)).toBeInTheDocument());
    expect(producerTagApi.downloadTagAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() =>
      expect(producerTagApi.downloadTagAudio).toHaveBeenCalledWith("tag-1/clip.webm")
    );
    expect(document.querySelector("audio")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissTag).toHaveBeenCalledWith(sampleTag);
  });

  it("orders written and audio nudges chronologically, oldest first", async () => {
    renderFooter(makeActivity({ nudges: [sampleNudge], incomingTags: [sampleTag] }));

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(2));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // sampleNudge.sentAt is older than sampleTag.sentAt (constructed 1s apart above).
    expect(items[0]!.textContent).toMatch(/keep going/);
    expect(items[1]!.textContent).toMatch(/audio nudge/);
  });

  it("renders a pending request's detail line and optional message, with working Deny/Approve buttons", async () => {
    const resolveRequest = vi.fn();
    renderFooter(makeActivity({ requests: [sampleRequest], resolveRequest }));

    await waitFor(() =>
      expect(screen.getByText(/wants to unlock youtube\.com/)).toBeInTheDocument()
    );
    expect(screen.getByText(/please, I need youtube for research/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(resolveRequest).toHaveBeenCalledWith(sampleRequest, "denied");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(resolveRequest).toHaveBeenCalledWith(sampleRequest, "approved");
  });

  it("disables both resolve buttons only for the request currently being resolved", () => {
    const secondRequest: FriendRequest = { ...sampleRequest, id: "request-2", hostname: "reddit.com" };
    renderFooter(
      makeActivity({
        requests: [sampleRequest, secondRequest],
        resolvingRequestId: "request-1",
      })
    );

    const denyButtons = screen.getAllByRole("button", { name: "Deny" });
    const approveButtons = screen.getAllByRole("button", { name: "Approve" });
    expect(denyButtons[0]).toBeDisabled();
    expect(approveButtons[0]).toBeDisabled();
    expect(denyButtons[1]).not.toBeDisabled();
    expect(approveButtons[1]).not.toBeDisabled();
  });

  it("surfaces nudgesError/tagsError/requestsError/resolveError inline", () => {
    renderFooter(
      makeActivity({
        nudges: [sampleNudge],
        nudgesError: "network down",
        tagsError: "tag fetch failed",
        requests: [sampleRequest],
        requestsError: "requests fetch failed",
        resolveError: "a friend already answered it",
      })
    );

    expect(screen.getByText(/Couldn't load incoming nudges: network down/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load incoming audio nudges: tag fetch failed/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load friend requests: requests fetch failed/)).toBeInTheDocument();
    expect(screen.getByText(/a friend already answered it/)).toBeInTheDocument();
  });

  it("renders nothing (no sections) when there is genuinely nothing pending and nothing errored", () => {
    renderFooter(makeActivity());
    expect(document.querySelector(".nudges-and-requests-footer__nudges")).not.toBeInTheDocument();
    expect(document.querySelector(".nudges-and-requests-footer__requests")).not.toBeInTheDocument();
  });

  it("registers its refresh callback into the refresh registry", () => {
    const refresh = vi.fn();

    function Harness() {
      const refreshAll = useRefreshAll();
      return (
        <>
          <button type="button" onClick={refreshAll}>
            Refresh all (test harness)
          </button>
          <NudgesAndRequestsFooter {...makeActivity({ nudges: [sampleNudge], refresh })} />
        </>
      );
    }

    render(
      <RefreshRegistryProvider>
        <Harness />
      </RefreshRegistryProvider>
    );

    fireEvent.click(screen.getByText("Refresh all (test harness)"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
