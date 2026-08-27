import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { FriendGroupPanel } from "./FriendGroupPanel";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { FriendEvent } from "../../infrastructure/backend/sessionStatusSyncApi";
import type { FriendNudge } from "../../infrastructure/backend/nudgeApi";
import type { DigestSummary } from "../../infrastructure/backend/digestApi";
import type { ExtensionMessage } from "../../shared/messages";
import * as audioRecorder from "../../infrastructure/audio/audioRecorder";
import * as producerTagApi from "../../infrastructure/backend/producerTagApi";

// v2 Task 14: ProducerTagRecorder (rendered inside FriendGroupPanel) calls the real
// audioRecorder module directly - mocked here the same way ProducerTagRecorder.test.tsx mocks it,
// so these integration tests only exercise FriendGroupPanel's own wiring (which target friend it
// sends to, which messages it sends, how it renders incoming tags), not audioRecorder.ts's own
// MediaRecorder mechanics (covered separately, audioRecorder.test.ts). blobToBase64/
// downloadTagAudio are producerTagApi.ts's two functions FriendGroupPanel.tsx calls directly
// (never through sendMessage - see that file's own header comment for why) - mocked the same way.
vi.mock("../../infrastructure/audio/audioRecorder", () => ({
  MAX_RECORDING_MS: 10_000,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  getLastRecordingDurationMs: vi.fn(),
}));

vi.mock("../../infrastructure/backend/producerTagApi", () => ({
  blobToBase64: vi.fn(),
  downloadTagAudio: vi.fn(),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  // Isolates the dismissed-nudge cursor (nudgeDismissalState.ts, chrome.storage.local) between
  // tests - otherwise a dismissal persisted in one test would leak into the next.
  fakeBrowser.reset();
  vi.mocked(audioRecorder.startRecording).mockReset();
  vi.mocked(audioRecorder.stopRecording).mockReset();
  vi.mocked(audioRecorder.getLastRecordingDurationMs).mockReset().mockReturnValue(4200);
  vi.mocked(producerTagApi.blobToBase64).mockReset().mockResolvedValue("ZmFrZQ==");
  vi.mocked(producerTagApi.downloadTagAudio).mockReset();
});

// Fake timers are only enabled WITHIN the one test below that needs to control the auto-refresh
// interval directly - same reasoning ProducerTagRecorder.test.tsx's own identical safety net
// documents: React Testing Library's waitFor/findBy* helpers poll via the global setTimeout too,
// so leaving fake timers on globally would deadlock every other test in this file. Harmless no-op
// for every test that never enables them.
afterEach(() => {
  vi.useRealTimers();
});

const sampleEvent: FriendEvent = {
  id: "event-1",
  userId: "user-a",
  sessionId: "session-1",
  type: "SESSION_STARTED",
  displayLabel: "started a focus session",
  occurredAt: new Date("2026-01-01T12:00:00Z").getTime(),
};

const sampleNudge: FriendNudge = {
  id: "nudge-1",
  senderUserId: "user-friend",
  recipientUserId: "user-self",
  messageId: "keep-going",
  sentAt: new Date("2026-01-01T12:05:00Z").getTime(),
};

const sampleDigest: DigestSummary = {
  friendUserId: "user-friend",
  completedSessions: 3,
  abandonedSessions: 1,
  distractionCount: 2,
  recoveryRate: 0.5,
};

// On mount, FriendGroupPanel now fires several independent sendMessage calls (v2 Task 7:
// FRIEND_EVENTS_FETCH, AUTH_GET_SESSION, FRIENDS_LIST (v3.4 Task 2 - replaces GROUP_LIST_MINE ->
// GROUP_LIST_MEMBERS per group), NUDGES_FETCH; v2 Task 9: DIGEST_FETCH) - a single blanket
// `mockResolvedValue` (this file's pre-Task-7 style) would route the same response to every one
// of them, which breaks the moment any of them need different shapes. This router lets each test
// override only the message types it cares about; everything else gets a healthy, empty-but-ok
// default so unrelated sections of the panel render their "nothing here" state instead of an
// error.
type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    FRIEND_EVENTS_FETCH: () => ({ ok: true, events: [] }),
    AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
    FRIENDS_LIST: () => ({ ok: true, friendIds: [] }),
    NUDGES_FETCH: () => ({ ok: true, nudges: [] }),
    NUDGE_SEND: () => ({ ok: true }),
    DIGEST_FETCH: () => ({ ok: true, digests: [] }),
    PRODUCER_TAG_SENDS_FETCH: () => ({ ok: true, sends: [] }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

function callsOfType(spy: { mock: { calls: unknown[][] } }, type: ExtensionMessage["type"]) {
  return spy.mock.calls.filter((call) => (call[0] as ExtensionMessage).type === type);
}

describe("FriendGroupPanel — friend activity (pre-existing behavior)", () => {
  it("fetches friend events on mount via FRIEND_EVENTS_FETCH and renders them", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(routeSendMessage({ FRIEND_EVENTS_FETCH: () => ({ ok: true, events: [sampleEvent] }) }));

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
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("No recent friend activity.")).toBeInTheDocument());
  });

  it("shows an error message when the fetch response is ok:false", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIEND_EVENTS_FETCH: () => ({ ok: false, error: "Not signed in." }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load friend activity/)).toHaveTextContent("Not signed in.")
    );
  });

  it("surfaces an error and does not crash when sendMessage rejects", async () => {
    // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
    // connection. Receiving end does not exist." during service-worker startup races, or
    // extension-context-invalidated.
    vi.spyOn(messenger, "sendMessage").mockImplementation((msg: ExtensionMessage) =>
      msg.type === "FRIEND_EVENTS_FETCH"
        ? Promise.reject(new Error("connection lost"))
        : routeSendMessage({})(msg)
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load friend activity/)).toHaveTextContent("connection lost")
    );
  });

  it("refetches friend events specifically when the Refresh button is clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(callsOfType(sendMessageSpy, "FRIEND_EVENTS_FETCH")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(callsOfType(sendMessageSpy, "FRIEND_EVENTS_FETCH")).toHaveLength(2));
  });

  // Fix round 1: Refresh previously only re-triggered FRIEND_EVENTS_FETCH, so a user manually
  // refreshing wouldn't pick up new nudges without closing/reopening the panel.
  it("also refetches incoming nudges via NUDGES_FETCH when the Refresh button is clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(callsOfType(sendMessageSpy, "NUDGES_FETCH")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(callsOfType(sendMessageSpy, "NUDGES_FETCH")).toHaveLength(2));
  });

  // QA-discovered bug (v3.3 QA pass): a nudge sent while the recipient's Friends tab was already
  // open and mounted never appeared unless the user manually clicked Refresh or switched away to
  // another tab and back (which happens to remount this panel via SidePanelApp.tsx's conditional
  // `{activeTab === "friends" && <FriendsTab />}` rendering, re-triggering the mount-only fetch -
  // that "fix" was a coincidence of tab-switching causing a remount, not any deliberate refresh
  // path). The background friend-poll alarm (alarmHandlers.ts) polls Supabase roughly once a
  // minute and fires a chrome.notifications toast, but never told this already-mounted panel's own
  // React state to refetch - there was no live-update path at all, only mount and manual Refresh.
  // Matches the behavior the v3.2 QA script's own item 4 documents as expected ("within a few
  // seconds... give it a full poll cycle if it doesn't appear instantly") - this test proves that
  // promise is actually kept now, on the same "roughly once a minute" cadence
  // infrastructure/browser/alarmsApi.ts's own header comment documents for the backend alarm.
  it("automatically refetches incoming nudges on a timer, with no manual Refresh click or remount needed", async () => {
    vi.useFakeTimers();
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    // Flush the mount effect's own microtask before advancing the interval timer - mirrors
    // ProducerTagRecorder.test.tsx's identical fake-timer-with-async-mock convention.
    await vi.advanceTimersByTimeAsync(0);
    expect(callsOfType(sendMessageSpy, "NUDGES_FETCH")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(callsOfType(sendMessageSpy, "NUDGES_FETCH")).toHaveLength(2);
  });

  // QA-discovered bug (v3.2 Task 9 two-account run): the group owner's friend list never
  // re-fetched after a second account joined mid-session - Refresh explicitly excluded
  // loadFriends (an omission carried forward through every earlier "Refresh means refresh
  // everything" fix round, not a considered exclusion - see git history on the exclusion
  // comment), so a newly-joined member never appeared for anyone whose panel was already open.
  it("also rediscovers friends via FRIENDS_LIST when the Refresh button is clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(callsOfType(sendMessageSpy, "FRIENDS_LIST")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(callsOfType(sendMessageSpy, "FRIENDS_LIST")).toHaveLength(2));
  });

  it("calls onClose when Close is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));
    const onClose = vi.fn();

    render(<FriendGroupPanel onClose={onClose} />);
    await waitFor(() => screen.getByText("No recent friend activity."));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });

  // v3.4 Task 4: onClose is now optional - FriendsTab.tsx (the only production mount point) no
  // longer passes one at all, so the Close button must not render there. Verified directly rather
  // than inferred from reading the source.
  it("does not render a Close button when onClose is omitted", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel />);
    await waitFor(() => screen.getByText("No recent friend activity."));

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});

// v3.4 Task 8: NudgeSendForm.tsx (source of these tests originally) is now merged into
// NudgeSendSection.tsx with a Written/Audio toggle. "Written" is the default mode, so every test
// below - written entirely against the panel's default render, with no toggle click - still
// exercises the exact same behavior as before the merge.
describe("FriendGroupPanel — send a nudge, written mode (v2 Task 7, merged v3.4 Task 8)", () => {
  it("discovers friends via FRIENDS_LIST (excluding self, by construction) and renders the predefined message catalog", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIENDS_LIST: () => ({
          ok: true,
          friendIds: ["user-friend"],
        }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    // "user-self" (the current user) must never appear as a nudge target.
    await waitFor(() => expect(screen.getByRole("option", { name: "user-friend" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "user-self" })).not.toBeInTheDocument();

    // The predefined catalog (domain/accountability/nudgeMessages.ts) renders as buttons - not a
    // free-text input, since nudges are predefined-only.
    expect(screen.getByRole("button", { name: "You've got this." })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows a 'no friends yet' message when the user has no groups", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/No friends to nudge yet/)).toBeInTheDocument());
  });

  it("sends NUDGE_SEND with the selected friend and message, and shows a confirmation on success", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIENDS_LIST: () => ({ ok: true, friendIds: ["user-friend"] }),
        NUDGE_SEND: () => ({ ok: true }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: "You've got this." }));

    fireEvent.click(screen.getByRole("button", { name: "You've got this." }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "NUDGE_SEND",
        payload: { friendUserId: "user-friend", messageId: "you-got-this" },
      })
    );
    await waitFor(() => expect(screen.getByText("Nudge sent.")).toBeInTheDocument());
  });

  // v3.2 Task 2: signed out, FRIENDS_LIST degrades this section's friendIds to [] the same way
  // "no friends yet" does, which used to render the misleading "No friends to nudge yet — join a
  // group first." (implying an account/group problem, not a sign-in problem). This now
  // distinguishes the two cases.
  it("shows an inline sign-in prompt instead of 'No friends to nudge yet' when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    expect(
      await screen.findByText("Sign in to nudge friends.")
    ).toBeInTheDocument();
    // Two independent SignInForm instances render (this section's, and the digest section's
    // below - both gate on the same signed-out state) - getAllByRole, not getByRole. v3.3 Task
    // 14: SignInForm's entry state is now a Create account/Sign in choice (Decision 6), not a
    // bare email field - "Create account" is the entry-state signal each instance renders.
    expect(screen.getAllByRole("button", { name: "Create account" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No friends to nudge yet/)).not.toBeInTheDocument();
  });

  it("shows the server's rejection reason inline (e.g. cooldown/toggle off) on ok:false, without silently swallowing it", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        FRIENDS_LIST: () => ({ ok: true, friendIds: ["user-friend"] }),
        NUDGE_SEND: () => ({
          ok: false,
          error: "Couldn't send that nudge — this friend may have nudges turned off, or you're on cooldown.",
        }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => screen.getByRole("button", { name: "You've got this." }));

    fireEvent.click(screen.getByRole("button", { name: "You've got this." }));

    await waitFor(() =>
      expect(screen.getByText(/Couldn't send that nudge/)).toHaveTextContent("cooldown")
    );
  });
});

describe("FriendGroupPanel — incoming nudges (v2 Task 7)", () => {
  it("renders an incoming nudge using the SnufflesOverlay warning visual pattern (same CSS classes, role=alert, Snuffles image, message text, sender)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [sampleNudge] }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    // Scoped by the exact reused CSS class (rather than assuming there's only ever one
    // role="alert" on the page - error banners elsewhere in the panel use it too) to confirm
    // this specific card is what SnufflesOverlay.tsx's warning state renders: same classes,
    // role=alert, a Snuffles image, and the nudge's message text + sender.
    const card = await waitFor(() => {
      const el = document.querySelector(".snuffles-overlay.snuffles-overlay--warning");
      if (!el) throw new Error("incoming nudge card not rendered yet");
      return el as HTMLElement;
    });
    expect(card.getAttribute("role")).toBe("alert");
    expect(within(card).getByRole("img", { name: "Snuffles" })).toBeInTheDocument();
    expect(within(card).getByText("Thinking of you — keep going!")).toBeInTheDocument();
    expect(within(card).getByText(/user-friend/)).toBeInTheDocument();
  });

  it("dismisses the visible nudge and reveals the next queued one when Dismiss is clicked", async () => {
    const secondNudge: FriendNudge = {
      ...sampleNudge,
      id: "nudge-2",
      messageId: "you-got-this",
      sentAt: sampleNudge.sentAt + 1000,
    };
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [sampleNudge, secondNudge] }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Thinking of you — keep going!")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(screen.getByText("You've got this.")).toBeInTheDocument());
    expect(screen.queryByText("Thinking of you — keep going!")).not.toBeInTheDocument();
  });

  // QA-discovered bug (v3.4 QA pass): dismissing a nudge, then leaving and returning to the
  // Friends tab (which unmounts and remounts FriendGroupPanel - see FriendsTab.tsx), used to bring
  // the dismissed nudge right back, since dismissal only ever lived in component state. Simulates
  // "leave and return" directly via unmount()+render() rather than anything more elaborate, since
  // that's the exact mechanism SidePanelApp.tsx's tab-switching conditional rendering uses.
  it("keeps a dismissed nudge dismissed after the panel unmounts and remounts (leaving and returning to the Friends tab)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ NUDGES_FETCH: () => ({ ok: true, nudges: [sampleNudge] }) })
    );

    const { unmount } = render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Thinking of you — keep going!")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByText("Thinking of you — keep going!")).not.toBeInTheDocument()
    );

    unmount();
    render(<FriendGroupPanel onClose={() => {}} />);

    // Give the remounted panel's own NUDGES_FETCH + dismissal-cursor loads a chance to resolve,
    // then confirm the same nudge does NOT reappear - the actual regression being fixed.
    await waitFor(() => screen.getByText("No recent friend activity."));
    expect(screen.queryByText("Thinking of you — keep going!")).not.toBeInTheDocument();
    expect(document.querySelector(".snuffles-overlay")).not.toBeInTheDocument();
  });

  it("shows nothing extra when there are no incoming nudges", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => screen.getByText("No recent friend activity."));

    expect(document.querySelector(".snuffles-overlay")).not.toBeInTheDocument();
  });
});

describe("FriendGroupPanel — daily digest (v2 Task 9)", () => {
  it("fetches the digest for yesterday's date on mount via DIGEST_FETCH and renders it in approachable copy", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ DIGEST_FETCH: () => ({ ok: true, digests: [sampleDigest] }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "DIGEST_FETCH",
        payload: { date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      })
    );
    // Approachable copy, not raw field names (completedSessions/abandonedSessions/etc never
    // appear verbatim) - per this task's brief ("Bob was really locked in today").
    await waitFor(() =>
      expect(screen.getByText(/was really locked in today/)).toBeInTheDocument()
    );
    expect(screen.getByText(/3 sessions completed/)).toBeInTheDocument();
    expect(screen.getByText(/50% recovered/)).toBeInTheDocument();
    expect(screen.queryByText(/completedSessions/)).not.toBeInTheDocument();
  });

  it("filters out the caller's own digest row (this panel is the friend-activity view)", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        AUTH_GET_SESSION: () => ({ ok: true, session: { user: { id: "user-self" } } }),
        DIGEST_FETCH: () => ({
          ok: true,
          digests: [sampleDigest, { ...sampleDigest, friendUserId: "user-self" }],
        }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Friend user-friend/)).toBeInTheDocument());
    expect(screen.queryByText(/Friend user-self/)).not.toBeInTheDocument();
  });

  it("shows a friendly empty state when there is no digest yet", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/No digest yet for yesterday/)).toBeInTheDocument());
  });

  it("shows an error message when the digest fetch response is ok:false", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ DIGEST_FETCH: () => ({ ok: false, error: "Not signed in." }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the daily digest/)).toHaveTextContent("Not signed in.")
    );
  });

  it("also refetches the digest via DIGEST_FETCH when the Refresh button is clicked", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);
    await waitFor(() => expect(callsOfType(sendMessageSpy, "DIGEST_FETCH")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(callsOfType(sendMessageSpy, "DIGEST_FETCH")).toHaveLength(2));
  });

  // v3.2 Task 2: signed out, DIGEST_FETCH degrades to [] the same way "no digest yet" does,
  // which used to render the misleading "No digest yet for yesterday..." empty state. This now
  // distinguishes the two cases, once self-identity (via loadFriends()) is actually known.
  it("shows an inline sign-in prompt instead of the empty-digest message when signed out", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ AUTH_GET_SESSION: () => ({ ok: true, session: null }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    expect(
      await screen.findByText("Sign in to see your friends' daily digest.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/No digest yet for yesterday/)).not.toBeInTheDocument();
  });
});

// v2 Task 14.
function routeSendMessageWithFriend(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  return routeSendMessage({
    FRIENDS_LIST: () => ({ ok: true, friendIds: ["user-friend"] }),
    ...overrides,
  });
}

// v3.4 Task 8: ProducerTagSection.tsx (source of these tests originally) is now merged into
// NudgeSendSection.tsx. The incoming-tags list still renders unconditionally (unaffected by the
// Written/Audio toggle - same as before the merge), but the record/send flow now lives behind the
// "Audio" toggle button, so those specific tests click it first before finding the recorder.
describe("FriendGroupPanel — Producer Tags / audio nudges (v2 Task 14, merged v3.4 Task 8)", () => {
  it("fetches incoming producer tags on mount via PRODUCER_TAG_SENDS_FETCH and renders them", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        PRODUCER_TAG_SENDS_FETCH: () => ({
          ok: true,
          sends: [
            {
              tagId: "tag-1",
              senderUserId: "user-friend",
              sentAt: Date.now(),
              audioUrl: "tag-1/clip.webm",
              durationMs: 4000,
            },
          ],
        }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);

    expect(await screen.findByText(/From friend user-friend/)).toBeInTheDocument();
  });

  it("shows a friendly empty state when there are no producer tags", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    render(<FriendGroupPanel onClose={() => {}} />);

    expect(await screen.findByText("No producer tags yet.")).toBeInTheDocument();
  });

  it("downloads and plays an incoming tag's audio, lazily, only once 'Play' is pressed", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        PRODUCER_TAG_SENDS_FETCH: () => ({
          ok: true,
          sends: [
            {
              tagId: "tag-1",
              senderUserId: "user-friend",
              sentAt: Date.now(),
              audioUrl: "tag-1/clip.webm",
              durationMs: 4000,
            },
          ],
        }),
      })
    );
    vi.mocked(producerTagApi.downloadTagAudio).mockResolvedValue(new Blob(["audio-bytes"]));

    render(<FriendGroupPanel onClose={() => {}} />);
    await screen.findByText(/From friend user-friend/);
    expect(producerTagApi.downloadTagAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Play"));

    await waitFor(() => expect(producerTagApi.downloadTagAudio).toHaveBeenCalledWith("tag-1/clip.webm"));
    expect(document.querySelector("audio")).toBeInTheDocument();
  });

  it("records, uploads (base64-encoded), and sends a tag to the selected friend via PRODUCER_TAG_UPLOAD then PRODUCER_TAG_SEND_TO_FRIEND", async () => {
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(
      new Blob(["fake-audio"], { type: "audio/webm" })
    );
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessageWithFriend({
        PRODUCER_TAG_UPLOAD: () => ({
          ok: true,
          tag: { id: "tag-1", userId: "user-self", audioUrl: "tag-1/clip.webm", durationMs: 4200, createdAt: "x" },
        }),
        PRODUCER_TAG_SEND_TO_FRIEND: () => ({ ok: true }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    // "Send to friend <id>" only renders once ProducerTagRecorder reaches its preview step (after
    // Record -> Stop) - the friend picker itself (shared with written nudges) is what's loaded by
    // this point, confirmed via its <option>. v3.4 Task 8: ProducerTagRecorder itself only renders
    // in Audio mode now, so the toggle must be clicked first (Written is the default mode).
    await screen.findByRole("option", { name: "user-friend" });
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));

    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(screen.getByText("Send to friend user-friend")).not.toBeDisabled());

    fireEvent.click(screen.getByText("Send to friend user-friend"));

    await waitFor(() => expect(screen.getByText("Tag sent.")).toBeInTheDocument());
    expect(producerTagApi.blobToBase64).toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "PRODUCER_TAG_UPLOAD",
      payload: { audioBase64: "ZmFrZQ==", mimeType: "audio/webm", durationMs: 4200 },
    });
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "PRODUCER_TAG_SEND_TO_FRIEND",
      payload: { tagId: "tag-1", friendUserId: "user-friend" },
    });
  });

  it("surfaces an error inline when the upload fails, without attempting PRODUCER_TAG_SEND_TO_FRIEND", async () => {
    vi.mocked(audioRecorder.stopRecording).mockResolvedValue(new Blob(["x"], { type: "audio/webm" }));
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessageWithFriend({
        PRODUCER_TAG_UPLOAD: () => ({ ok: false, error: "Failed to upload the recorded audio." }),
      })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await screen.findByRole("option", { name: "user-friend" });
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    fireEvent.click(screen.getByText("Record a tag (10s max)"));
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(screen.getByText("Send to friend user-friend")).not.toBeDisabled());

    fireEvent.click(screen.getByText("Send to friend user-friend"));

    expect(await screen.findByText(/Tag not sent/)).toHaveTextContent(
      "Failed to upload the recorded audio."
    );
    expect(callsOfType(sendMessageSpy, "PRODUCER_TAG_SEND_TO_FRIEND")).toHaveLength(0);
  });
});

// v3.4 Task 8 DoD: "The merged 'Send a nudge' section shows exactly one friend picker and a
// Written/Audio toggle, never two separate friend pickers."
describe("FriendGroupPanel — merged nudge section, one picker + mode toggle (v3.4 Task 8)", () => {
  it("shows exactly one friend picker with a Written/Audio toggle, and switching modes swaps the content without adding a second picker", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ FRIENDS_LIST: () => ({ ok: true, friendIds: ["user-friend"] }) })
    );

    render(<FriendGroupPanel onClose={() => {}} />);
    await screen.findByRole("option", { name: "user-friend" });

    // Exactly one friend <select> in the whole panel - not one for written nudges and a second,
    // independent one for audio nudges/Producer Tags.
    expect(screen.getAllByRole("combobox")).toHaveLength(1);

    // Written is the default mode: message catalog visible, recorder not.
    expect(screen.getByRole("button", { name: "You've got this." })).toBeInTheDocument();
    expect(screen.queryByText(/Record a tag/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Written" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Audio" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Audio" }));

    // Audio mode: recorder visible, written message catalog hidden - still exactly one picker.
    expect(screen.getByText(/Record a tag/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "You've got this." })).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Audio" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Written" })).toHaveAttribute("aria-pressed", "false");
  });
});
