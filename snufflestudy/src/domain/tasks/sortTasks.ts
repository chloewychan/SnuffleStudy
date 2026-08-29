import type { Task } from "./taskTypes";

// v4.1 Task 6: Task Vault display order. Completed tasks sink to the bottom; uncompleted tasks
// stay on top, in their existing order — a stable sort (Array.prototype.sort is stable per spec)
// rather than re-ordering by title/date. Shared between TaskVaultPage.tsx (which owns the
// canonical `tasks` list) and SessionSetupForm.tsx (whose Goal select defaults to the first
// uncompleted task), so both stay consistent with each other without either re-implementing the
// grouping rule.
export function sortTasksForDisplay(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aDone = a.completedAt != null;
    const bDone = b.completedAt != null;
    if (aDone !== bDone) return aDone ? 1 : -1; // uncompleted first
    return 0; // stable: preserve existing relative order within each group
  });
}
