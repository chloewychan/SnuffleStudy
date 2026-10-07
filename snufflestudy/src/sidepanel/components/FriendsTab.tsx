import { FriendsBox } from "./FriendsBox";
import { NudgeVaultBox } from "./NudgeVaultBox";

// This tab mounts two stacked cards, matching the layout other tabs use:
// - FriendsBox: the multi-select friend checklist, bulk Nudge/Add-to-room actions, per-friend
//   Options popover, and Add/Invite-a-friend.
// - NudgeVaultBox: the user's own saved audio/written nudges.
//
// Study rooms and friend requests are not shown here - study rooms live in StudyTab.tsx and
// StudyRoomFooter.tsx, and incoming friend requests are always visible in the persistent Nudges
// & Unlock Requests footer.
export function FriendsTab() {
  return (
    <div className="sp-tab-content sp-friends-tab">
      <section className="sp-card">
        <FriendsBox />
      </section>
      <section className="sp-card">
        <NudgeVaultBox />
      </section>
    </div>
  );
}
