import { useStudyRoomSession } from "../studyRoom/StudyRoomSessionContext";
import { StudyRoomFooter } from "./StudyRoomFooter";

// v4.1 Task 7: the persistent app-shell footer shell - a sibling of Header.tsx mounted directly
// in SidePanelApp.tsx (not inside any per-tab conditional), so it stays mounted across tab
// switches and through the active-session view (Decision 5). Stacks up to two independent pieces,
// in order: the Study Room footer, then (once Task 8 lands) the Nudges & Unlock Requests footer
// beneath it.
//
// This task only wires up the Study Room half - Task 8 adds the Nudges & Unlock Requests half
// here, in the same conditional-stack shape, and widens the early-return condition below to also
// account for its own content.
export function AppFooter() {
  const { joinedRoom } = useStudyRoomSession();

  // Task 8 changes this condition to also check its own hasIncomingActivity.
  if (!joinedRoom) return null;

  return (
    <div className="sp-app-footer">
      {joinedRoom && <StudyRoomFooter />}
      {/* Task 8: {hasIncomingActivity && <NudgesAndRequestsFooter />} */}
    </div>
  );
}
