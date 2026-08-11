import { openDB, type IDBPDatabase } from "idb";
import type { StudySession, SessionEvent, HistoryQuery } from "../../domain/session/sessionTypes";

const DB_NAME = "snufflestudy";
const DB_VERSION = 1;
const SESSIONS_STORE = "sessions";
const EVENTS_STORE = "events";

export interface SessionRepository {
  archive(session: StudySession): Promise<void>;
  listHistory(options?: HistoryQuery): Promise<StudySession[]>;
  recordEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string): Promise<SessionEvent[]>;
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
}
