import { openDB, type IDBPDatabase } from "idb";
import type {
  StudySession,
  SessionEvent,
  HistoryQuery,
  SessionState,
} from "../../domain/session/sessionTypes";

const DB_NAME = "snufflestudy";
const DB_VERSION = 1;
const SESSIONS_STORE = "sessions";
const EVENTS_STORE = "events";

export interface SessionRepository {
  archive(session: StudySession): Promise<void>;
  listHistory(options?: HistoryQuery): Promise<StudySession[]>;
  countByState(state: SessionState): Promise<number>;
  recordEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string): Promise<SessionEvent[]>;
  // QA-discovered bug (v3.4): unlike Task (which has a userId field, scoped by
  // taskRepository.ts's by-userId index), StudySession/SessionEvent carry no account
  // identity at all - this store has always been genuinely device-wide, not per-account.
  // AUTH_DELETE_ACCOUNT's local cleanup (messageRouter.ts) already clears local tasks for
  // the departing account specifically; history has no equivalent "for this account" concept
  // to scope by, so clearAll() wipes both stores outright. This is the same class of gap the
  // v3.2 QA pass already found and fixed for tasks, just never extended to history at the
  // time - deliberately blunt (whole-device, not per-account) rather than a no-op.
  clearAll(): Promise<void>;
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const store = db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
        store.createIndex("by-state", "state");
        store.createIndex("by-createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const store = db.createObjectStore(EVENTS_STORE, { keyPath: "id" });
        store.createIndex("by-sessionId", "sessionId");
      }
    },
  });
}

export class IndexedDbSessionRepository implements SessionRepository {
  async archive(session: StudySession): Promise<void> {
    const db = await getDb();
    try {
      await db.put(SESSIONS_STORE, session);
    } finally {
      db.close();
    }
  }

  async listHistory(options: HistoryQuery = {}): Promise<StudySession[]> {
    const db = await getDb();
    let sessions: StudySession[];
    try {
      sessions = (await db.getAllFromIndex(SESSIONS_STORE, "by-createdAt")) as StudySession[];
    } finally {
      db.close();
    }
    sessions = sessions.reverse();

    if (options.since !== undefined) {
      sessions = sessions.filter((s) => s.createdAt >= options.since!);
    }
    if (options.state !== undefined) {
      sessions = sessions.filter((s) => s.state === options.state);
    }
    if (options.limit !== undefined) {
      sessions = sessions.slice(0, options.limit);
    }
    return sessions;
  }

  // Uses the sessions store's existing (previously unused) "by-state" index for an O(matching
  // rows) IndexedDB count - no full session records are fetched into memory. This backs the
  // CompletionScreen/AbandonedScreen ordinal counts (Task 4 fix round 2), which fire on every
  // single session end, not just on-demand history-page opens like listHistory does.
  async countByState(state: SessionState): Promise<number> {
    const db = await getDb();
    try {
      return await db.countFromIndex(SESSIONS_STORE, "by-state", state);
    } finally {
      db.close();
    }
  }

  async recordEvent(event: SessionEvent): Promise<void> {
    const db = await getDb();
    try {
      await db.put(EVENTS_STORE, event);
    } finally {
      db.close();
    }
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    const db = await getDb();
    try {
      return await db.getAllFromIndex(EVENTS_STORE, "by-sessionId", sessionId);
    } finally {
      db.close();
    }
  }

  async clearAll(): Promise<void> {
    const db = await getDb();
    try {
      await db.clear(SESSIONS_STORE);
      await db.clear(EVENTS_STORE);
    } finally {
      db.close();
    }
  }
}
