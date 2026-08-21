import { useEffect, useState, type FormEvent } from "react";
import type { Task, TaskBreakdownItem } from "../../domain/tasks/taskTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";

interface TaskVaultPageProps {
  onClose: () => void;
  // Bubbles up to SidePanelApp, which pre-fills SessionSetupForm's goal with the breakdown
  // item's description and threads taskBreakdownItemId through SESSION_CREATE, so the ending
  // session can mark this item's completedAt (messageRouter.ts's SESSION_END handler).
  onStartSessionFromBreakdownItem: (params: { goal: string; taskBreakdownItemId: string }) => void;
}

export function TaskVaultPage({ onClose, onStartSessionFromBreakdownItem }: TaskVaultPageProps) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [breakdownDrafts, setBreakdownDrafts] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

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

  async function handleAddBreakdownItem(taskId: string) {
    const description = (breakdownDrafts[taskId] ?? "").trim();
    if (!description) return;

    setActionError(null);
    try {
      const res = await sendMessage<{ ok: boolean; task?: Task; error?: string }>({
        type: "TASK_ADD_BREAKDOWN_ITEM",
        payload: { taskId, description },
      });
      if (!res.ok || !res.task) {
        setActionError(res.error ?? "Could not add breakdown item.");
        return;
      }
      setTasks((prev) => prev?.map((t) => (t.id === taskId ? res.task! : t)) ?? prev);
      setBreakdownDrafts((prev) => ({ ...prev, [taskId]: "" }));
    } catch (err) {
      console.error("Failed to add breakdown item", err);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleBreakdownItem(task: Task, item: TaskBreakdownItem) {
    // Optimistic update (mirrors OptionsApp.updateSettings): reflect the toggle immediately,
    // but roll back to the previous list if the save fails, so the UI never shows a checkbox
    // state that isn't actually persisted.
    const previous = tasks;
    const updatedTask: Task = {
      ...task,
      breakdown: task.breakdown.map((i) =>
        i.id === item.id ? { ...i, completedAt: i.completedAt ? undefined : Date.now() } : i
      ),
    };
    setTasks((prev) => prev?.map((t) => (t.id === task.id ? updatedTask : t)) ?? prev);
    setActionError(null);

    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "TASK_UPDATE",
        payload: updatedTask,
      });
      if (!res.ok) {
        setTasks(previous);
        setActionError(res.error ?? "Could not update breakdown item.");
      }
    } catch (err) {
      console.error("Failed to update breakdown item", err);
      setTasks(previous);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteTask(taskId: string) {
    const previous = tasks;
    setTasks((prev) => prev?.filter((t) => t.id !== taskId) ?? prev);
    setActionError(null);

    try {
      const res = await sendMessage<{ ok: boolean; error?: string }>({
        type: "TASK_DELETE",
        payload: { taskId },
      });
      if (!res.ok) {
        setTasks(previous);
        setActionError(res.error ?? "Could not delete task.");
      }
    } catch (err) {
      console.error("Failed to delete task", err);
      setTasks(previous);
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="task-vault-page">
      <div className="task-vault-page__header">
        <h2>Task Vault</h2>
        <button type="button" onClick={onClose}>
          Back
        </button>
      </div>

      <form className="task-vault-page__new-task" onSubmit={handleCreateTask}>
        <label>
          New task
          <input
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="STAT231"
          />
        </label>
        <button type="submit" disabled={creating || !newTaskTitle.trim()}>
          {creating ? "Adding…" : "Add task"}
        </button>
      </form>
      {createError && <p role="alert">Couldn't create task: {createError}. Please try again.</p>}

      {loadError && <p role="alert">Couldn't load tasks: {loadError}. Please try again.</p>}
      {actionError && <p role="alert">{actionError}</p>}

      {!loadError && tasks === null && <p>Loading…</p>}
      {!loadError && tasks !== null && tasks.length === 0 && <p>No tasks yet.</p>}

      {!loadError && tasks !== null && tasks.length > 0 && (
        <ul className="task-vault-page__tasks">
          {tasks.map((task) => (
            <li key={task.id} className="task-vault-page__task">
              <div className="task-vault-page__task-header">
                <span className="task-vault-page__task-title">{task.title}</span>
                <button type="button" onClick={() => void handleDeleteTask(task.id)}>
                  Delete
                </button>
              </div>

              {task.breakdown.length > 0 && (
                <ul className="task-vault-page__breakdown">
                  {task.breakdown.map((item) => (
                    <li key={item.id} className="task-vault-page__breakdown-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(item.completedAt)}
                          onChange={() => void handleToggleBreakdownItem(task, item)}
                        />
                        {item.description}
                      </label>
                      {!item.completedAt && (
                        <button
                          type="button"
                          onClick={() =>
                            onStartSessionFromBreakdownItem({
                              goal: item.description,
                              taskBreakdownItemId: item.id,
                            })
                          }
                        >
                          Start a session from this
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="task-vault-page__add-breakdown"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleAddBreakdownItem(task.id);
                }}
              >
                <input
                  aria-label={`Add breakdown item for ${task.title}`}
                  value={breakdownDrafts[task.id] ?? ""}
                  onChange={(e) =>
                    setBreakdownDrafts((prev) => ({ ...prev, [task.id]: e.target.value }))
                  }
                  placeholder="Chapter 6 of STAT231"
                />
                <button type="submit" disabled={!(breakdownDrafts[task.id] ?? "").trim()}>
                  Add breakdown item
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
