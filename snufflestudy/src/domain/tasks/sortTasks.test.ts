import { describe, it, expect } from "vitest";
import { sortTasksForDisplay } from "./sortTasks";
import type { Task } from "./taskTypes";

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    userId: null,
    title: "Untitled",
    createdAt: 1000,
    ...overrides,
  };
}

describe("sortTasksForDisplay", () => {
  it("sinks completed tasks below uncompleted ones", () => {
    const done = buildTask({ id: "done", title: "Done", completedAt: 500 });
    const notDone = buildTask({ id: "not-done", title: "Not done" });

    const result = sortTasksForDisplay([done, notDone]);

    expect(result.map((t) => t.id)).toEqual(["not-done", "done"]);
  });

  it("preserves existing relative order within the uncompleted group", () => {
    const a = buildTask({ id: "a", title: "A" });
    const b = buildTask({ id: "b", title: "B" });
    const c = buildTask({ id: "c", title: "C" });

    const result = sortTasksForDisplay([b, c, a]);

    expect(result.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("preserves existing relative order within the completed group", () => {
    const a = buildTask({ id: "a", title: "A", completedAt: 10 });
    const b = buildTask({ id: "b", title: "B", completedAt: 20 });

    const result = sortTasksForDisplay([b, a]);

    expect(result.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const done = buildTask({ id: "done", completedAt: 500 });
    const notDone = buildTask({ id: "not-done" });
    const input = [done, notDone];

    sortTasksForDisplay(input);

    expect(input).toEqual([done, notDone]);
  });

  it("returns an empty array unchanged", () => {
    expect(sortTasksForDisplay([])).toEqual([]);
  });
});
