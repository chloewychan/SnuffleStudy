import { useState } from "react";
import { SessionSetupForm } from "./SessionSetupForm";
import { TaskVaultPage } from "../../app/routes/TaskVaultPage";
import type { UserSettings } from "../../domain/settings/userSettings";
import type { Task } from "../../domain/tasks/taskTypes";

interface StudyTabProps {
  settings: UserSettings;
}

export function StudyTab({ settings }: StudyTabProps) {
  const [prefill, setPrefill] = useState<{ goal: string; taskBreakdownItemId: string } | null>(
    null
  );

  // Fix 1 (final-review fix wave): TaskVaultPage is still the sole owner of the actual TASK_LIST
  // fetch/CRUD (its onTasksChanged callback mirrors its `tasks` state up here whenever it changes -
  // initial load, create, delete, update, breakdown-item add). SessionSetupForm receives this
  // mirrored list as a prop instead of fetching its own copy, so a task created in the Task Vault
  // card is immediately selectable in the Goal select above it - without a second TASK_LIST
  // round-trip. Previously each child fetched TASK_LIST independently and never shared results,
  // which both duplicated the fetch and left the Goal select stale until SessionSetupForm remounted.
  const [tasks, setTasks] = useState<Task[]>([]);

  return (
    <div className="sp-tab-content sp-study-tab">
      <section className="sp-card">
        {/* SessionSetupForm seeds its internal `goal` state from `initialGoal` only once, on
            mount (`useState(initialGoal ?? "")` - see SessionSetupForm.tsx), so a later prop
            change alone would not re-prefill an already-mounted form. Keying on the breakdown
            item id forces a remount whenever a new "Start a session from this" pick comes in
            from Task Vault, so the new initialGoal actually takes effect. This remount is
            orthogonal to the `tasks` prop below - `tasks` state lives here in StudyTab, not in
            SessionSetupForm, so remounting doesn't clear or stale it. */}
        <SessionSetupForm
          key={prefill?.taskBreakdownItemId ?? "default"}
          settings={settings}
          initialGoal={prefill?.goal}
          taskBreakdownItemId={prefill?.taskBreakdownItemId}
          tasks={tasks}
        />
      </section>
      <section className="sp-card">
        <TaskVaultPage
          onClose={() => {}}
          onStartSessionFromBreakdownItem={(params) => setPrefill(params)}
          onTasksChanged={setTasks}
        />
      </section>
    </div>
  );
}
