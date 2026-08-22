import { useState } from "react";
import { SessionSetupForm } from "./SessionSetupForm";
import { TaskVaultPage } from "../../app/routes/TaskVaultPage";
import type { UserSettings } from "../../domain/settings/userSettings";

interface StudyTabProps {
  settings: UserSettings;
}

export function StudyTab({ settings }: StudyTabProps) {
  const [prefill, setPrefill] = useState<{ goal: string; taskBreakdownItemId: string } | null>(
    null
  );

  return (
    <div className="sp-tab-content sp-study-tab">
      <section className="sp-card">
        {/* SessionSetupForm seeds its internal `goal` state from `initialGoal` only once, on
            mount (`useState(initialGoal ?? "")` - see SessionSetupForm.tsx), so a later prop
            change alone would not re-prefill an already-mounted form. Keying on the breakdown
            item id forces a remount whenever a new "Start a session from this" pick comes in
            from Task Vault, so the new initialGoal actually takes effect. */}
        <SessionSetupForm
          key={prefill?.taskBreakdownItemId ?? "default"}
          settings={settings}
          initialGoal={prefill?.goal}
          taskBreakdownItemId={prefill?.taskBreakdownItemId}
        />
      </section>
      <section className="sp-card">
        <TaskVaultPage
          onClose={() => {}}
          onStartSessionFromBreakdownItem={(params) => setPrefill(params)}
        />
      </section>
    </div>
  );
}
