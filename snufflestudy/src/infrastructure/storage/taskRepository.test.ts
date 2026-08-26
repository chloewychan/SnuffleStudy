import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDbTaskRepository } from "./taskRepository";
import type { Task } from "../../domain/tasks/taskTypes";

function buildTask(id: string, createdAt: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    userId: null,
    title: `Task ${id}`,
    createdAt,
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

    const tasks = await repo.list(null);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("task_1");
  });

  it("lists tasks newest-first", async () => {
    const repo = new IndexedDbTaskRepository();
    await repo.create(buildTask("task_1", 1000));
    await repo.create(buildTask("task_2", 2000));

    const tasks = await repo.list(null);
    expect(tasks.map((t) => t.id)).toEqual(["task_2", "task_1"]);
  });

  it("updates an existing task", async () => {
    const repo = new IndexedDbTaskRepository();
    const task = buildTask("task_1", 1000);
    await repo.create(task);

    await repo.update({ ...task, title: "Renamed", completedAt: 5000 });

    const tasks = await repo.list(null);
    expect(tasks[0]!.title).toBe("Renamed");
    expect(tasks[0]!.completedAt).toBe(5000);
  });

  it("deletes a task", async () => {
    const repo = new IndexedDbTaskRepository();
    await repo.create(buildTask("task_1", 1000));
    await repo.create(buildTask("task_2", 2000));

    await repo.delete("task_1");

    const tasks = await repo.list(null);
    expect(tasks.map((t) => t.id)).toEqual(["task_2"]);
  });

  // QA-discovered bug (v3.2): tasks used to have no account scoping at all - every account (and
  // signed-out use) shared the exact same list.
  describe("account scoping", () => {
    it("only lists tasks belonging to the requested userId", async () => {
      const repo = new IndexedDbTaskRepository();
      await repo.create(buildTask("task_a", 1000, { userId: "user-a" }));
      await repo.create(buildTask("task_b", 2000, { userId: "user-b" }));
      await repo.create(buildTask("task_signed_out", 3000, { userId: null }));

      expect((await repo.list("user-a")).map((t) => t.id)).toEqual(["task_a"]);
      expect((await repo.list("user-b")).map((t) => t.id)).toEqual(["task_b"]);
      expect((await repo.list(null)).map((t) => t.id)).toEqual(["task_signed_out"]);
    });

    it("backfills a pre-existing (v1 schema) task with no userId field to signed-out, not dropped", async () => {
      // Simulates a real upgrade: a v1 database (no by-userId index, no userId field on the
      // stored record at all) that already has data before this migration ever runs.
      const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("snufflestudy-tasks", 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore("tasks", { keyPath: "id" });
          store.createIndex("by-createdAt", "createdAt");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = v1Db.transaction("tasks", "readwrite");
        tx.objectStore("tasks").put({ id: "legacy_task", title: "Pre-migration task", createdAt: 500 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      v1Db.close();

      const repo = new IndexedDbTaskRepository();
      const signedOutTasks = await repo.list(null);

      expect(signedOutTasks.map((t) => t.id)).toEqual(["legacy_task"]);
      expect(signedOutTasks[0]!.userId).toBeNull();
    });

    it("deleteAllForUser removes only that user's tasks, leaving everyone else's untouched", async () => {
      const repo = new IndexedDbTaskRepository();
      await repo.create(buildTask("task_a1", 1000, { userId: "user-a" }));
      await repo.create(buildTask("task_a2", 2000, { userId: "user-a" }));
      await repo.create(buildTask("task_b", 3000, { userId: "user-b" }));
      await repo.create(buildTask("task_signed_out", 4000, { userId: null }));

      await repo.deleteAllForUser("user-a");

      expect(await repo.list("user-a")).toEqual([]);
      expect((await repo.list("user-b")).map((t) => t.id)).toEqual(["task_b"]);
      expect((await repo.list(null)).map((t) => t.id)).toEqual(["task_signed_out"]);
    });
  });
});
