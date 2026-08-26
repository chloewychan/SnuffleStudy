import { useState } from "react";
import { SessionSetupForm } from "./SessionSetupForm";
import { TaskVaultPage } from "../../app/routes/TaskVaultPage";
import type { UserSettings } from "../../domain/settings/userSettings";
import type { Task } from "../../domain/tasks/taskTypes";

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
        <SessionSetupForm settings={settings} tasks={tasks} />
      </section>
      <section className="sp-card">
        <TaskVaultPage onClose={() => {}} onTasksChanged={setTasks} />
      </section>
    </div>
  );
}
