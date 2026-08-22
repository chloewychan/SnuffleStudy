import { useEffect, useState, type FormEvent } from "react";
import type { UserSettings } from "../../domain/settings/userSettings";
import { PRESSURE_PROFILES } from "../../domain/pressure/pressureProfiles";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { requestHardBlockHostPermission } from "../../infrastructure/browser/permissionsApi";
import type { Task } from "../../domain/tasks/taskTypes";

interface SessionSetupFormProps {
  settings: UserSettings;
  // Set by SidePanelApp when the user picked "Start a session from this" on a Task Vault
  // breakdown item (app/routes/TaskVaultPage.tsx) - pre-fills the goal field with that item's
  // description, but the field stays freely editable afterward (it's only the initial value).
  initialGoal?: string;
  taskBreakdownItemId?: string;
}

export function SessionSetupForm({ settings, initialGoal, taskBreakdownItemId }: SessionSetupFormProps) {
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [focusHours, setFocusHours] = useState(Math.floor(settings.defaultFocusDurationSeconds / 3600));
  const [focusMinutes, setFocusMinutes] = useState(
    Math.round((settings.defaultFocusDurationSeconds % 3600) / 60)
  );
  const [pressureProfileId, setPressureProfileId] = useState(settings.pressureProfileId);
  const [restrictionMode, setRestrictionMode] = useState(settings.defaultRestrictionMode);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sendMessage<{ ok: boolean; tasks?: Task[]; error?: string }>({ type: "TASK_LIST" })
      .then((res) => {
        if (!cancelled && res.ok && res.tasks) setTasks(res.tasks);
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
  }, []);

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
          taskBreakdownItemId,
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
      <label className="sp-field" htmlFor="session-goal">
        Goal
        <select id="session-goal" value={goal} onChange={(e) => setGoal(e.target.value)}>
          <option value="" disabled>
            Choose a task from the Task Vault
          </option>
          {/* initialGoal (from the Task Vault "Start a session from this" flow) is a breakdown
              item's description, which won't generally match any tasks[].title exactly - render
              it as its own option so the select can display/hold it without forcing it into the
              Task Vault list, while still letting the user pick a different task afterward. */}
          {goal && !tasks.some((task) => task.title === goal) && <option value={goal}>{goal}</option>}
          {tasks.map((task) => (
            <option key={task.id} value={task.title}>
              {task.title}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="sp-field">
        <legend>Focus Duration</legend>
        <label htmlFor="session-focus-hours">
          Hours
          <input
            id="session-focus-hours"
            type="number"
            min={0}
            max={3}
            value={focusHours}
            onChange={(e) => setFocusHours(Number(e.target.value))}
          />
        </label>
        <label htmlFor="session-focus-minutes">
          Minutes
          <input
            id="session-focus-minutes"
            type="number"
            min={0}
            max={59}
            value={focusMinutes}
            onChange={(e) => setFocusMinutes(Number(e.target.value))}
          />
        </label>
      </fieldset>
      <label>
        Pressure style
        <select value={pressureProfileId} onChange={(e) => setPressureProfileId(e.target.value)}>
          {PRESSURE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <label className="sp-field" htmlFor="session-restriction-mode">
        Restriction Mode
        <select
          id="session-restriction-mode"
          value={restrictionMode}
          onChange={(e) => setRestrictionMode(e.target.value as "soft" | "hard")}
        >
          <option value="soft">Soft - nudge &amp; escalate</option>
          <option value="hard">Hard</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Starting…" : "Start session"}
      </button>
    </form>
  );
}
