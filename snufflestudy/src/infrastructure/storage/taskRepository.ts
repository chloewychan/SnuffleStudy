import { openDB, type IDBPDatabase } from "idb";
import type { Task, TaskBreakdownItem } from "../../domain/tasks/taskTypes";

// A separate database from indexedDbRepository.ts's "snufflestudy" (sessions/events) rather
// than a new store bolted onto it - that would require bumping DB_VERSION there and keeping
// two files' version numbers in lockstep, and this task's brief scopes changes to a new
// taskRepository.ts file only, not edits to indexedDbRepository.ts.
const DB_NAME = "snufflestudy-tasks";
// v2: QA-discovered bug - tasks had no account scoping at all, so every signed-in (or signed-
// out) identity on a given device saw the exact same shared list, and account deletion could
// never reach them (this is local IndexedDB, not Supabase - the server has no way to touch it).
// Adds a "by-userId" index; existing rows are backfilled to userId: null ("created while signed
// out") rather than left to silently drop out of every future userId-scoped query.
const DB_VERSION = 2;
const TASKS_STORE = "tasks";

// IndexedDB constraint (confirmed by a failing test, not assumed): `null` is not a valid
// IndexedDB key. A record whose indexed property is `null` is silently EXCLUDED from that index
// entirely (not an error), and passing `null` as a getAllFromIndex/openCursor query means "no
// filter, return everything" rather than "match the literal null value." Storing Task.userId's
// `null` ("created while signed out") directly under the by-userId index would therefore make
// signed-out tasks invisible to list(null) while simultaneously making list(null) return every
// OTHER user's tasks too - the exact bug this whole fix exists to close, reintroduced by a
// different mechanism. Every read/write through this file translates between the domain's
// `string | null` and this storage-only string sentinel at the boundary; nothing outside this
// file ever sees SIGNED_OUT_KEY.
const SIGNED_OUT_KEY = "__signed_out__";

function toStorageUserId(userId: string | null): string {
  return userId ?? SIGNED_OUT_KEY;
}

function fromStorageRecord(record: Task): Task {
  return (record.userId as unknown) === SIGNED_OUT_KEY ? { ...record, userId: null } : record;
}

export interface TaskRepository {
  create(task: Task): Promise<void>;
  update(task: Task): Promise<void>;
  delete(taskId: string): Promise<void>;
  list(userId: string | null): Promise<Task[]>;
  // Every task regardless of owner - for internal reconciliation only (alarmHandlers.ts's
  // markBreakdownItemCompleted: a timer-driven background event with no "current signed-in
  // user" to scope by, that has to find whichever task a completing session's breakdown item
  // belongs to no matter who created it, or who - if anyone - happens to be signed in right
  // now). Never exposed through a TASK_* message; user-facing reads always go through list().
  listAll(): Promise<Task[]>;
  addBreakdownItem(taskId: string, description: string): Promise<Task>;
  // Removes every task belonging to one account - the local-storage half of account deletion
  // (supabase/migrations/20260815000032_v3.2_account_deletion.sql only ever reaches Supabase
  // tables; nothing server-side can delete a row that never left this device). userId is
  // required (not nullable, unlike list()) - there is no legitimate reason to bulk-delete every
  // signed-out task, only ever a specific deleted account's own.
  deleteAllForUser(userId: string): Promise<void>;
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains(TASKS_STORE)) {
        const store = db.createObjectStore(TASKS_STORE, { keyPath: "id" });
        store.createIndex("by-createdAt", "createdAt");
        store.createIndex("by-userId", "userId");
        return;
      }

      if (oldVersion < 2) {
        const store = transaction.objectStore(TASKS_STORE);
        store.createIndex("by-userId", "userId");
        // idb's cursor .update()/.continue() are promise-wrapped specifically to support this
        // kind of in-place migration inside an async upgrade() callback.
        let cursor = await store.openCursor();
        while (cursor) {
          if (!("userId" in cursor.value)) {
            await cursor.update({ ...cursor.value, userId: SIGNED_OUT_KEY });
          }
          cursor = await cursor.continue();
        }
      }
    },
  });
}

export class IndexedDbTaskRepository implements TaskRepository {
  async create(task: Task): Promise<void> {
    const db = await getDb();
    try {
      await db.put(TASKS_STORE, { ...task, userId: toStorageUserId(task.userId) });
    } finally {
      db.close();
    }
  }

  async update(task: Task): Promise<void> {
    const db = await getDb();
    try {
      await db.put(TASKS_STORE, { ...task, userId: toStorageUserId(task.userId) });
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

  async list(userId: string | null): Promise<Task[]> {
    const db = await getDb();
    let tasks: Task[];
    try {
      tasks = (await db.getAllFromIndex(
        TASKS_STORE,
        "by-userId",
        toStorageUserId(userId)
      )) as Task[];
    } finally {
      db.close();
    }
    // Newest-first, matching IndexedDbSessionRepository.listHistory's convention. Sorted
    // explicitly (unlike the old by-createdAt-indexed version) since querying by-userId no
    // longer returns rows in createdAt order for free.
    return tasks.map(fromStorageRecord).sort((a, b) => b.createdAt - a.createdAt);
  }

  async listAll(): Promise<Task[]> {
    const db = await getDb();
    let tasks: Task[];
    try {
      tasks = (await db.getAllFromIndex(TASKS_STORE, "by-createdAt")) as Task[];
    } finally {
      db.close();
    }
    return tasks.map(fromStorageRecord).reverse();
  }

  async deleteAllForUser(userId: string): Promise<void> {
    const db = await getDb();
    try {
      const tx = db.transaction(TASKS_STORE, "readwrite");
      let cursor = await tx.store.index("by-userId").openCursor(toStorageUserId(userId));
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    } finally {
      db.close();
    }
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
      return fromStorageRecord(updated);
    } finally {
      db.close();
    }
  }
}
