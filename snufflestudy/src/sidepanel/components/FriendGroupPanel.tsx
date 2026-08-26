import { useState } from "react";
import { IncomingNudgeCard } from "./friendGroupPanel/IncomingNudgeCard";
import { NudgeSendSection } from "./friendGroupPanel/NudgeSendSection";
import { DigestSection } from "./friendGroupPanel/DigestSection";
import { FriendEventFeed } from "./friendGroupPanel/FriendEventFeed";
import { useFriendGroupPanelData } from "./friendGroupPanel/useFriendGroupPanelData";

interface FriendGroupPanelProps {
  // v3.4 Task 4: optional - this used to be a routed page with somewhere real to close to;
  // permanently embedded in FriendsTab.tsx now, with nowhere to go, so FriendsTab.tsx no longer
  // passes a no-op here. The Close button below only renders when a real handler is passed.
  onClose?: () => void;
}

// v3.2 Task 7: this panel is a thin container composing focused sections (see
// ./friendGroupPanel/*) plus the shared useFriendGroupPanelData() hook that owns the independent
// load* fetches (events, friends, nudges, digests, producer tags) and their state. Split out with
// no behavior change from the pre-split ~590-line version - same messages sent, same rendering
// order, same CSS class names. See docs/reports/v3.2/task-7-report.md for the per-file rundown and
// the judgment calls behind how state/props were divided.
//
// v3.4 Task 8: NudgeSendForm.tsx and ProducerTagSection.tsx (previously two separate mounts here,
// each with its own <h3>) are merged into one NudgeSendSection.tsx with a Written/Audio toggle -
// see that file and supabase/migrations/20260815000044_v3.4_nudge_cooldowns_and_producer_tag_rate_limit.sql.
//
// `selectedFriendId`/`effectiveFriendId` stay here rather than in the hook or NudgeSendSection
// itself, because they're genuinely shared UI state, not fetch state: NudgeSendSection's <select>
// sets it, and both its written-message buttons and its audio-recorder's send target read it - the
// one piece of state neither the merged section nor the load-focused hook owns exclusively.
export function FriendGroupPanel({ onClose }: FriendGroupPanelProps) {
  const {
    events,
    error,
    loading,
    loadEvents,

    selfUserId,
    friendIds,
    friendsError,
    friendsLoading,
    loadFriends,

    nudgesError,
    visibleNudge,
    dismissNudge,
    loadNudges,

    friendDigests,
    digestsError,
    loadDigests,

    incomingTags,
    tagsError,
    loadProducerTags,
  } = useFriendGroupPanelData();

  const [selectedFriendId, setSelectedFriendId] = useState("");

  // The friend the picker targets: whatever the user explicitly picked, defaulting to the first
  // loaded friend otherwise - so a user with exactly one friend (the common case early on)
  // doesn't have to interact with the select at all before sending. Computed inline during
  // render rather than synced into state via a second useEffect (an earlier version did that,
  // and had a real bug: the effect that called setSelectedFriendId only fires on the render
  // *after* friendIds first becomes non-empty, so the message buttons could render already
  // enabled-looking but still be disabled/no-op for one extra render pass). This derivation is
  // synchronous with the same render that first shows the buttons, so there's no such gap.
  const effectiveFriendId = selectedFriendId || friendIds?.[0] || "";

  function handleRefresh() {
    // Fix round 1: Refresh previously only re-triggered FRIEND_EVENTS_FETCH, so a user
    // manually refreshing wouldn't pick up new nudges without closing/reopening the panel
    // - both fetches now run together, matching what "Refresh" implies. v2 Task 9: the
    // daily digest fetch joins the same "Refresh means refresh everything" convention. v2
    // Task 14: producer tags join the same convention.
    //
    // QA-discovered bug (v3.2 Task 9 two-account run): loadFriends was never added here -
    // not a considered exclusion despite an earlier comment claiming otherwise (checked via
    // git history: it was simply never wired in when it was introduced, and every later fix
    // round preserved that gap rather than questioning it). Consequence: once a panel is
    // mounted, a friend who joins the shared group afterward never appears for the
    // already-open side, in either direction, no matter how many times Refresh is clicked -
    // only fully closing and reopening the panel re-triggers the mount-only loadFriends().
    loadEvents();
    loadFriends();
    loadNudges();
    loadDigests();
    loadProducerTags();
  }

  return (
    <div className="friend-group-panel">
      <header className="friend-group-panel__header">
        <h2>Friend activity</h2>
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </header>

      {visibleNudge && (
        <IncomingNudgeCard nudge={visibleNudge} onDismiss={() => dismissNudge(visibleNudge.id)} />
      )}
      {nudgesError && (
        <p role="alert">Couldn't load incoming nudges: {nudgesError}. Please try again.</p>
      )}

      <NudgeSendSection
        friendsLoading={friendsLoading}
        friendsError={friendsError}
        friendIds={friendIds}
        selfUserId={selfUserId}
        effectiveFriendId={effectiveFriendId}
        onSelectFriend={setSelectedFriendId}
        onFriendsReload={loadFriends}
        incomingTags={incomingTags}
        tagsError={tagsError}
      />

      <DigestSection
        digestsError={digestsError}
        friendDigests={friendDigests}
        friendIds={friendIds}
        selfUserId={selfUserId}
        onReload={loadDigests}
      />

      <FriendEventFeed events={events} error={error} loading={loading} onRefresh={handleRefresh} />
    </div>
  );
}
