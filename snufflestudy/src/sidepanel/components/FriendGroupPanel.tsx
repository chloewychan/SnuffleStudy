import { useState } from "react";
import { IncomingNudgeCard } from "./friendGroupPanel/IncomingNudgeCard";
import { NudgeSendForm } from "./friendGroupPanel/NudgeSendForm";
import { DigestSection } from "./friendGroupPanel/DigestSection";
import { ProducerTagSection } from "./friendGroupPanel/ProducerTagSection";
import { FriendEventFeed } from "./friendGroupPanel/FriendEventFeed";
import { useFriendGroupPanelData } from "./friendGroupPanel/useFriendGroupPanelData";

interface FriendGroupPanelProps {
  onClose: () => void;
}

// v3.2 Task 7: this panel is now a thin container composing five focused sections (see
// ./friendGroupPanel/*) plus the shared useFriendGroupPanelData() hook that owns the five
// independent load* fetches (events, friends, nudges, digests, producer tags) and their state.
// Split out with no behavior change from the pre-split ~590-line version - same messages sent,
// same rendering order, same CSS class names. See docs/reports/v3.2/task-7-report.md for the
// file-by-file breakdown and the judgment calls behind how state/props were divided.
//
// `selectedFriendId`/`effectiveFriendId` stay here rather than in the hook or either section,
// because they're genuinely shared UI state, not fetch state: NudgeSendForm's <select> sets it,
// and both NudgeSendForm's message buttons and ProducerTagSection's send target read it - the one
// piece of state neither an individual section nor the load-focused hook owns exclusively.
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
    // Task 14: producer tags join the same convention. loadFriends is deliberately excluded,
    // matching the pre-split behavior exactly.
    loadEvents();
    loadNudges();
    loadDigests();
    loadProducerTags();
  }

  return (
    <div className="friend-group-panel">
      <header className="friend-group-panel__header">
        <h2>Friend activity</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {visibleNudge && (
        <IncomingNudgeCard nudge={visibleNudge} onDismiss={() => dismissNudge(visibleNudge.id)} />
      )}
      {nudgesError && (
        <p role="alert">Couldn't load incoming nudges: {nudgesError}. Please try again.</p>
      )}

      <NudgeSendForm
        friendsLoading={friendsLoading}
        friendsError={friendsError}
        friendIds={friendIds}
        selfUserId={selfUserId}
        effectiveFriendId={effectiveFriendId}
        onSelectFriend={setSelectedFriendId}
        onFriendsReload={loadFriends}
      />

      <DigestSection
        digestsError={digestsError}
        friendDigests={friendDigests}
        friendIds={friendIds}
        selfUserId={selfUserId}
        onReload={loadDigests}
      />

      <ProducerTagSection
        effectiveFriendId={effectiveFriendId}
        incomingTags={incomingTags}
        tagsError={tagsError}
      />

      <FriendEventFeed events={events} error={error} loading={loading} onRefresh={handleRefresh} />
    </div>
  );
}
