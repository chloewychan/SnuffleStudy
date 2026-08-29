import { useEffect, useState, type FormEvent } from "react";
import type { Task } from "../../domain/tasks/taskTypes";
import { sortTasksForDisplay } from "../../domain/tasks/sortTasks";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import styles from "../../sidepanel/styles/frontend-backup/components/study/TaskVaultPanel.module.css";

interface TaskVaultPageProps {
  // v3.4 Task 4: optional - this used to be a routed page with somewhere real to close to;
  // permanently embedded in StudyTab.tsx now, with nowhere to go, so StudyTab.tsx no longer
  // passes a no-op here. The Back button below only renders when a real handler is passed.
  onClose?: () => void;
  // Fix 1 (final-review fix wave): fires with this component's own `tasks` list every time it
  // changes (initial TASK_LIST load, create/delete mutations). StudyTab.tsx uses this to mirror
  // the list into a prop it hands to SessionSetupForm's Goal select, so a task created here is
  // immediately selectable there too - without SessionSetupForm issuing its own, separate
  // TASK_LIST fetch. Optional so this component still works unchanged when mounted standalone
  // (e.g. this file's own tests, which don't pass it).
  onTasksChanged?: (tasks: Task[]) => void;
}

export function TaskVaultPage({ onClose, onTasksChanged }: TaskVaultPageProps) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (tasks !== null) onTasksChanged?.(tasks);
    // onTasksChanged is a fresh closure from the parent on most renders (StudyTab.tsx passes
    // `setTasks` directly, which is stable, but a future caller might not) - only `tasks` itself
    // should gate re-firing this, matching the intent ("notify when the list changes") rather than
    // re-running on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  useEffect(() => {
    let cancelled = false;

    sendMessage<{ ok: boolean; tasks?: Task[]; error?: string }>({ type: "TASK_LIST" })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.tasks) {
          setLoadError(res.error ?? "Could not load tasks.");
          return;
        }
        setTasks(res.tasks);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated. Surface it instead of leaving the page stuck on
        // "Loading…" forever with no signal.
        console.error("Failed to load tasks", err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreateTask(e: FormEvent) {
    e.preventDefault();
    const title = newTaskTitle.trim();
    if (!title) return;

    setCreating(true);
    setCreateError(null);
    try {
      const res = await sendMessage<{ ok: boolean; task?: Task; error?: string }>({
        type: "TASK_CREATE",
        payload: { title },
      });
      if (!res.ok || !res.task) {
        setCreateError(res.error ?? "Could not create task.");
        return;
      }
      setTasks((prev) => [res.task!, ...(prev ?? [])]);
      setNewTaskTitle("");
    } catch (err) {
      // sendMessage can reject — same rationale as the TASK_LIST fetch above.
      console.error("Failed to create task", err);
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleTaskCompleted(task: Task, checked: boolean) {
    const previous = tasks;
    const updated: Task = { ...task, completedAt: checked ? Date.now() : undefined };
    setTasks((prev) => prev?.map((t) => (t.id === task.id ? updated : t)) ?? prev);
    setActionError(null);

    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "TASK_UPDATE",
        payload: updated,
      });
      if (!res.ok) {
        setTasks(previous);
        setActionError(res.error ?? "Could not update task.");
      }
    } catch (err) {
      console.error("Failed to update task", err);
      setTasks(previous);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className={styles.taskVaultPanel}>
      <h2 className={styles.studySession}>Task Vault</h2>
      {/* No design equivalent (frontend-backup's TaskVaultPanel has nowhere to navigate "back"
          to) - StudyTab.tsx (the only production mount point) doesn't pass onClose at all, so
          this never renders there today. Kept, unstyled, purely so the optional prop/behavior
          this component has always supported keeps working for any other caller. */}
      {onClose && (
        <button type="button" onClick={onClose}>
          Back
        </button>
      )}

      <div className={styles.frameNewTask}>
        <form className={styles.inputNewTask} onSubmit={handleCreateTask}>
          <label className={styles.goal} htmlFor="new-task-title">
            New Task
          </label>
          <div className={styles.input6}>
            <input
              id="new-task-title"
              className={styles.textbox}
              placeholder="Textbox"
              type="text"
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className={styles.buttonIconReset}
            disabled={creating || !newTaskTitle.trim()}
            aria-label={creating ? "Adding…" : "Add task"}
          >
            <img
              className={styles.buttonIcon}
              alt=""
              src={chrome.runtime.getURL("sidepanel/assets/button-check.svg")}
            />
          </button>
        </form>
        {createError && <p role="alert">Couldn't create task: {createError}. Please try again.</p>}

        {loadError && <p role="alert">Couldn't load tasks: {loadError}. Please try again.</p>}
        {actionError && <p role="alert">{actionError}</p>}

        {!loadError && tasks === null && <p>Loading…</p>}
        {!loadError && tasks !== null && tasks.length === 0 && <p>No tasks yet.</p>}

        {!loadError && tasks !== null && tasks.length > 0 && (
          <ul className={styles.exampleList}>
            {sortTasksForDisplay(tasks).map((task) => (
              <li key={task.id}>
                <label className={styles.exampleListItem3}>
                  <input
                    type="checkbox"
                    className={styles.buttonList}
                    checked={task.completedAt != null}
                    onChange={(e) => void handleToggleTaskCompleted(task, e.target.checked)}
                  />
                  <h3 className={styles.egTaskOne}>{task.title}</h3>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
