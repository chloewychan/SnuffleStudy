import { useState } from "react";
import { SessionSetupForm } from "./SessionSetupForm";
import { TaskVaultPage } from "../../app/routes/TaskVaultPage";
import { StudyRoomsBox } from "./StudyRoomsBox";
import type { UserSettings } from "../../domain/settings/userSettings";
import type { Task } from "../../domain/tasks/taskTypes";
import { sortTasksForDisplay } from "../../domain/tasks/sortTasks";

interface StudyTabProps {
  settings: UserSettings;
}

export function StudyTab({ settings }: StudyTabProps) {
  // Fix 1 (final-review fix wave): TaskVaultPage is still the sole owner of the actual TASK_LIST
  // fetch/CRUD (its onTasksChanged callback mirrors its `tasks` state up here whenever it changes -
  // initial load, create, delete). SessionSetupForm receives this mirrored list as a prop instead
  // of fetching its own copy, so a task created in the Task Vault card is immediately selectable
  // in the Goal select above it - without a second TASK_LIST round-trip. Previously each child
  // fetched TASK_LIST independently and never shared results, which both duplicated the fetch and
  // left the Goal select stale until SessionSetupForm remounted.
  const [tasks, setTasks] = useState<Task[]>([]);

  return (
    <div className="sp-tab-content sp-study-tab">
      <section className="sp-card">
        <h2 className="sp-card__title">Study Session</h2>
        {/* v4.1 Task 6: sort here too (SessionSetupForm also sorts internally from whatever
            `tasks` prop it's given, so this is belt-and-suspenders) so the Goal default and its
            option order stay consistent with the Task Vault's own completed-sinks-to-bottom
            ordering regardless of which layer's sort runs first. */}
        <SessionSetupForm settings={settings} tasks={sortTasksForDisplay(tasks)} />
      </section>
      <section className="sp-card">
        <TaskVaultPage onTasksChanged={setTasks} />
      </section>
      {/* v4.1 Task 7: Study Rooms moved in from the Friends tab - the list/create/manage-access
          view only. The joined-room view is the persistent, app-shell-level Study Room footer
          (StudyRoomFooter.tsx via AppFooter.tsx), not part of this tab. */}
      <section className="sp-card">
        <StudyRoomsBox />
      </section>
    </div>
  );
}
