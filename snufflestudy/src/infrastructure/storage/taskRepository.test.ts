import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDbTaskRepository } from "./taskRepository";
import type { Task } from "../../domain/tasks/taskTypes";

function buildTask(id: string, createdAt: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    createdAt,
    breakdown: [],
    ...overrides,
  };
}

beforeEach(() => {
  indexedDB.deleteDatabase("snufflestudy-tasks");
});

describe("IndexedDbTaskRepository", () => {
  it("creates a task and retrieves it via list", async () => {
    const repo = new IndexedDbTaskRepository();
    await repo.create(buildTask("task_1", 1000));

    const tasks = await repo.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("task_1");
  });

  it("lists tasks newest-first", async () => {
    const repo = new IndexedDbTaskRepository();
    await repo.create(buildTask("task_1", 1000));
    await repo.create(buildTask("task_2", 2000));

    const tasks = await repo.list();
    expect(tasks.map((t) => t.id)).toEqual(["task_2", "task_1"]);
  });

  it("updates an existing task", async () => {
    const repo = new IndexedDbTaskRepository();
    const task = buildTask("task_1", 1000);
    await repo.create(task);

    await repo.update({ ...task, title: "Renamed", completedAt: 5000 });

    const tasks = await repo.list();
    expect(tasks[0]!.title).toBe("Renamed");
    expect(tasks[0]!.completedAt).toBe(5000);
  });

  it("deletes a task", async () => {
    const repo = new IndexedDbTaskRepository();
    await repo.create(buildTask("task_1", 1000));
    await repo.create(buildTask("task_2", 2000));

    await repo.delete("task_1");

    const tasks = await repo.list();
    expect(tasks.map((t) => t.id)).toEqual(["task_2"]);
  });

  it("adds a breakdown item to a task and returns the updated task", async () => {
    const repo = new IndexedDbTaskRepository();
    await repo.create(buildTask("task_1", 1000));

    const updated = await repo.addBreakdownItem("task_1", "Chapter 6 of STAT231");

    expect(updated.breakdown).toHaveLength(1);
    expect(updated.breakdown[0]!.description).toBe("Chapter 6 of STAT231");
    expect(updated.breakdown[0]!.completedAt).toBeUndefined();
    expect(updated.breakdown[0]!.id).toEqual(expect.any(String));

    const tasks = await repo.list();
    expect(tasks[0]!.breakdown).toHaveLength(1);
  });

  it("appends multiple breakdown items without clobbering earlier ones", async () => {
    const repo = new IndexedDbTaskRepository();
    await repo.create(buildTask("task_1", 1000));

    await repo.addBreakdownItem("task_1", "First item");
    const afterSecond = await repo.addBreakdownItem("task_1", "Second item");

    expect(afterSecond.breakdown.map((i) => i.description)).toEqual(["First item", "Second item"]);
  });

  it("rejects adding a breakdown item to a nonexistent task", async () => {
    const repo = new IndexedDbTaskRepository();
    await expect(repo.addBreakdownItem("does-not-exist", "desc")).rejects.toThrow();
  });
});
