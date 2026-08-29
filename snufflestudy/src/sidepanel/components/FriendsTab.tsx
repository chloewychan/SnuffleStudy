import { FriendsBox } from "./FriendsBox";
import { NudgeVaultBox } from "./NudgeVaultBox";

// v4.1 Task 9: FriendGroupPanel.tsx (and its NudgeSendSection/DigestSection/FriendEventFeed/
// IncomingNudgeCard children) is deleted - this tab now mounts exactly two boxes, matching every
// other tab's stacked-card layout (StudyTab.tsx's SessionSetupForm/TaskVaultPage/StudyRoomsBox
// precedent):
// - FriendsBox: the multi-select friend checklist, bulk Nudge/Add-to-room actions, per-friend
//   Options popover, and Add/Invite-a-friend (moved in from AccountPage.tsx - see that file's own
//   comment on the stub removal).
// - NudgeVaultBox: the user's own saved audio/written nudges, replacing the old "Friend activity"
//   panel entirely (its event feed and daily digest are dropped, not relocated - scope doc's
//   Friends Tab section).
//
// v4.1 Task 7: StudyRoomPanel is no longer mounted here at all - split into StudyRoomsBox.tsx
// (moved to StudyTab.tsx) and the persistent StudyRoomFooter.tsx (mounted via AppFooter.tsx at
// the app-shell level).
//
// v4.1 Task 8: the old standalone "Friend requests" panel that used to be mounted here was
// already deleted - its approver-side content is always visible in the persistent Nudges &
// Unlock Requests footer instead.
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
