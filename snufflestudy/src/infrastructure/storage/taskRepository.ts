import { openDB, type IDBPDatabase } from "idb";
import type { Task, TaskBreakdownItem } from "../../domain/tasks/taskTypes";

// A separate database from indexedDbRepository.ts's "snufflestudy" (sessions/events) rather
// than a new store bolted onto it - that would require bumping DB_VERSION there and keeping
// two files' version numbers in lockstep, and this task's brief scopes changes to a new
// taskRepository.ts file only, not edits to indexedDbRepository.ts.
const DB_NAME = "snufflestudy-tasks";
const DB_VERSION = 1;
const TASKS_STORE = "tasks";

export interface TaskRepository {
  create(task: Task): Promise<void>;
  update(task: Task): Promise<void>;
  delete(taskId: string): Promise<void>;
  list(): Promise<Task[]>;
  addBreakdownItem(taskId: string, description: string): Promise<Task>;
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(TASKS_STORE)) {
        const store = db.createObjectStore(TASKS_STORE, { keyPath: "id" });
        store.createIndex("by-createdAt", "createdAt");
      }
    },
  });
}

export class IndexedDbTaskRepository implements TaskRepository {
  async create(task: Task): Promise<void> {
    const db = await getDb();
    try {
      await db.put(TASKS_STORE, task);
    } finally {
      db.close();
    }
  }

  async update(task: Task): Promise<void> {
    const db = await getDb();
    try {
      await db.put(TASKS_STORE, task);
    } finally {
      db.close();
    }
  }

  async delete(taskId: string): Promise<void> {
    const db = await getDb();
    try {
      await db.delete(TASKS_STORE, taskId);
    } finally {
      db.close();
    }
  }

  async list(): Promise<Task[]> {
    const db = await getDb();
    let tasks: Task[];
    try {
      tasks = (await db.getAllFromIndex(TASKS_STORE, "by-createdAt")) as Task[];
    } finally {
      db.close();
    }
    // Newest-first, matching IndexedDbSessionRepository.listHistory's convention.
    return tasks.reverse();
  }

  async addBreakdownItem(taskId: string, description: string): Promise<Task> {
    const db = await getDb();
    try {
      const task = (await db.get(TASKS_STORE, taskId)) as Task | undefined;
      if (!task) {
        throw new Error(`No task with id ${taskId}`);
      }
      const item: TaskBreakdownItem = {
        id: crypto.randomUUID(),
        description,
      };
      const updated: Task = { ...task, breakdown: [...task.breakdown, item] };
      await db.put(TASKS_STORE, updated);
      return updated;
    } finally {
      db.close();
    }
  }
}
