import { useEffect, useId, useState, type FormEvent } from "react";
import type { UserSettings } from "../../domain/settings/userSettings";
import { PRESSURE_PROFILES } from "../../domain/pressure/pressureProfiles";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { requestHardBlockHostPermission } from "../../infrastructure/browser/permissionsApi";
import type { Task } from "../../domain/tasks/taskTypes";
import { sortTasksForDisplay } from "../../domain/tasks/sortTasks";
import { Input } from "./ui/Input";
import { ButtonLarge } from "./ui/ButtonLarge";

interface SessionSetupFormProps {
  settings: UserSettings;
  // When provided, the Goal select is populated from this list instead of this component fetching
  // its own TASK_LIST copy. StudyTab.tsx (which mounts this component right next to TaskVaultPage)
  // passes its own task list here, sourced from TaskVaultPage's onTasksChanged callback - that's
  // what keeps a task created in the Task Vault card immediately selectable in this Goal select
  // (previously this component's own mount-only fetch never saw tasks created after it mounted -
  // see Fix 1 in the final-review fix report). When omitted, this component fetches its own copy
  // so it still works correctly when mounted standalone (e.g. this file's own tests).
  tasks?: Task[];
}

// design-specs/frames/page-study.json's frame-study-session: Goal/Pressure Style/Restriction Mode
// are dropdowns, Focus Duration is two textboxes (hours/minutes) - confirmed by matching each
// label's node id against its nearest-id value widget (each label+input pair was authored
// together in Figma), not by document order (which interleaves them differently).
export function SessionSetupForm({ settings, tasks: tasksProp }: SessionSetupFormProps) {
  const [fetchedTasks, setFetchedTasks] = useState<Task[]>([]);
  // v4.1 Task 6: completed tasks sink to the bottom (sortTasksForDisplay), so the first entry
  // here is the first uncompleted task - the Goal select's default.
  const tasks = tasksProp ?? fetchedTasks;
  const sortedTasks = sortTasksForDisplay(tasks);
  const [goal, setGoal] = useState(sortedTasks[0]?.title ?? "");
  const [focusHours, setFocusHours] = useState(Math.floor(settings.defaultFocusDurationSeconds / 3600));
  const [focusMinutes, setFocusMinutes] = useState(
    Math.round((settings.defaultFocusDurationSeconds % 3600) / 60)
  );
  const [pressureProfileId, setPressureProfileId] = useState(settings.pressureProfileId);
  const [restrictionMode, setRestrictionMode] = useState(settings.defaultRestrictionMode);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const idPrefix = useId();
  const goalFieldId = `${idPrefix}-goal`;
  const focusDurationLabelId = `${idPrefix}-focus-duration-label`;
  const pressureFieldId = `${idPrefix}-pressure`;
  const restrictionFieldId = `${idPrefix}-restriction`;

  useEffect(() => {
    // The parent already owns a task list (see the `tasks` prop comment above) - skip this
    // component's own fetch entirely rather than issuing a redundant, duplicate TASK_LIST call.
    if (tasksProp) return;
    let cancelled = false;
    sendMessage<{ ok: boolean; tasks?: Task[]; error?: string }>({ type: "TASK_LIST" })
      .then((res) => {
        if (!cancelled && res.ok && res.tasks) setFetchedTasks(res.tasks);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated. Surface it via the existing `error` state
        // instead of leaving an unhandled rejection with no signal to the user (the Goal
        // select still renders, just without Task Vault options to choose from).
        console.error("Failed to load tasks", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tasksProp]);

  useEffect(() => {
    // The `goal` useState initializer above only runs once, at first mount - if the task list
    // (whether the `tasks` prop, mirrored asynchronously by StudyTab.tsx from TaskVaultPage's own
    // TASK_LIST fetch, or this component's own fallback fetch above) is still empty at that
    // moment, the default is missed. Fill it in once real tasks arrive, but never override a goal
    // the user has already typed or picked themselves.
    if (goal !== "") return;
    const firstUncompleted = sortedTasks[0];
    if (firstUncompleted) setGoal(firstUncompleted.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (restrictionMode === "hard" && settings.defaultRestrictedSites.length > 0) {
        const granted = await requestHardBlockHostPermission(settings.defaultRestrictedSites);
        if (!granted) {
          setError(
            "Hard-mode blocking needs permission to act on your restricted sites. Grant it to start a hard-restricted session, or switch to soft mode."
          );
          return;
        }
      }

      const createResponse = await sendMessage<{
        ok: boolean;
        session?: { id: string };
        errors?: string[];
      }>({
        type: "SESSION_CREATE",
        payload: {
          goal,
          focusDurationSeconds: focusHours * 3600 + focusMinutes * 60,
          breakDurationSeconds: settings.defaultBreakDurationSeconds,
          pressureProfileId,
          allowedSites: settings.defaultAllowedSites,
          restrictedSites: settings.defaultRestrictedSites,
          restrictionMode,
        },
      });

      if (!createResponse.ok || !createResponse.session) {
        setError(createResponse.errors?.join(" ") ?? "Could not create session.");
        return;
      }

      await sendMessage({ type: "SESSION_START", payload: { sessionId: createResponse.session.id } });
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated. Surface it via the existing `error` state
      // instead of throwing from the form's onSubmit handler and leaving the button
      // silently doing nothing.
      console.error("Failed to start session", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="session-setup-form" onSubmit={handleSubmit}>
      <div className="sp-form-fields">
        <label htmlFor={goalFieldId}>Goal</label>
        <Input
          variant="dropdown"
          id={goalFieldId}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        >
          <option value="" disabled>
            Choose a task from the Task Vault
          </option>
          {/* A freely-typed goal won't generally match any tasks[].title exactly - render it as
              its own option so the select can display/hold it without forcing it into the Task
              Vault list, while still letting the user pick a different task afterward. */}
          {goal && !sortedTasks.some((task) => task.title === goal) && <option value={goal}>{goal}</option>}
          {sortedTasks.map((task) => (
            <option key={task.id} value={task.title}>
              {task.title}
            </option>
          ))}
        </Input>

        <label id={focusDurationLabelId}>Focus Duration</label>
        <div className="session-setup-form__duration" role="group" aria-labelledby={focusDurationLabelId}>
          <Input
            type="number"
            min={0}
            max={3}
            aria-label="Hours"
            value={focusHours}
            onChange={(e) => setFocusHours(Math.min(3, Math.max(0, Number(e.target.value) || 0)))}
          />
          <Input
            type="number"
            min={0}
            max={59}
            aria-label="Minutes"
            value={focusMinutes}
            onChange={(e) => setFocusMinutes(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
          />
        </div>

        <label htmlFor={pressureFieldId}>Pressure Style</label>
        <Input
          variant="dropdown"
          id={pressureFieldId}
          value={pressureProfileId}
          onChange={(e) => setPressureProfileId(e.target.value)}
        >
          {PRESSURE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </Input>

        <label htmlFor={restrictionFieldId}>Restriction Mode</label>
        <Input
          variant="dropdown"
          id={restrictionFieldId}
          value={restrictionMode}
          onChange={(e) => setRestrictionMode(e.target.value as "soft" | "hard")}
        >
          <option value="soft">Soft</option>
          <option value="hard">Hard</option>
        </Input>
      </div>
      {error && <p role="alert">{error}</p>}
      <ButtonLarge type="submit" disabled={submitting}>
        {submitting ? "Starting…" : "Start Study Session"}
      </ButtonLarge>
    </form>
  );
}
