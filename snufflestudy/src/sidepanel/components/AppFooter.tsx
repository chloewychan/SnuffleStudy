import { useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";
import { StudyRoomFooter } from "./StudyRoomFooter";
import { NudgesAndRequestsFooter } from "./NudgesAndRequestsFooter";
import { useIncomingActivity } from "../appFooter/useIncomingActivity";

// The persistent app-shell footer - a sibling of Header.tsx mounted directly in
// SidePanelApp.tsx (not inside any per-tab conditional), so it stays mounted across tab
// switches and through the active-session view. Stacks up to two independent pieces, in order:
// the Study Room footer, then the Nudges & Unlock Requests footer beneath it.
//
// useIncomingActivity() is called exactly once, here (one poll loop, not one per consumer), and
// its result is threaded down to NudgesAndRequestsFooter as props, rather than that component
// calling the hook itself.
export function AppFooter() {
  const { joinedRoom } = useStudyRoomSession();
  const activity = useIncomingActivity();

  const hasIncomingActivity =
    activity.nudges.length > 0 || activity.requests.length > 0 || activity.incomingTags.length > 0;

  if (!joinedRoom && !hasIncomingActivity) return null;

  return (
    <div className="sp-app-footer">
      {joinedRoom && <StudyRoomFooter />}
      {hasIncomingActivity && <NudgesAndRequestsFooter {...activity} />}
    </div>
  );
}
