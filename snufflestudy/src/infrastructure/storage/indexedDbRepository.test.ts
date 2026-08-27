import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDbSessionRepository } from "./indexedDbRepository";
import * as machine from "../../domain/session/sessionMachine";
import type { CreateSessionInput } from "../../domain/session/sessionTypes";

function buildSession(id: string, createdAt: number, state: "COMPLETED" | "ABANDONED" = "COMPLETED") {
  const input: CreateSessionInput = {
    goal: `Goal for ${id}`,
    focusDurationSeconds: 1500,
    breakDurationSeconds: 300,
    pressureProfileId: "strict-coach",
    allowedSites: [],
    restrictedSites: [],
    restrictionMode: "soft",
  };
  const created = machine.createSession(input, id, createdAt);
  const started = machine.startSession(created, createdAt);
  return state === "COMPLETED"
    ? machine.completeSession(started, createdAt + 1_500_000)
    : machine.abandonSession(started, createdAt + 500_000);
}

beforeEach(() => {
  indexedDB.deleteDatabase("snufflestudy");
});

describe("IndexedDbSessionRepository", () => {
  it("archives a session and retrieves it via listHistory", async () => {
    const repo = new IndexedDbSessionRepository();
    const session = buildSession("session_1", 1000);
    await repo.archive(session);

    const history = await repo.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe("session_1");
  });

  it("orders history newest-first", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000));
    await repo.archive(buildSession("session_2", 2000));

    const history = await repo.listHistory();
    expect(history.map((s) => s.id)).toEqual(["session_2", "session_1"]);
  });

  it("filters history by since", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000));
    await repo.archive(buildSession("session_2", 5000));

    const history = await repo.listHistory({ since: 2000 });
    expect(history.map((s) => s.id)).toEqual(["session_2"]);
  });

  it("filters history by state", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000, "COMPLETED"));
    await repo.archive(buildSession("session_2", 2000, "ABANDONED"));

    const history = await repo.listHistory({ state: "ABANDONED" });
    expect(history.map((s) => s.id)).toEqual(["session_2"]);
  });

  it("limits history results", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000));
    await repo.archive(buildSession("session_2", 2000));
    await repo.archive(buildSession("session_3", 3000));

    const history = await repo.listHistory({ limit: 2 });
    expect(history).toHaveLength(2);
  });

  it("counts sessions by state using the by-state index", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000, "COMPLETED"));
    await repo.archive(buildSession("session_2", 2000, "COMPLETED"));
    await repo.archive(buildSession("session_3", 3000, "ABANDONED"));

    expect(await repo.countByState("COMPLETED")).toBe(2);
    expect(await repo.countByState("ABANDONED")).toBe(1);
  });

  it("returns 0 from countByState when no sessions match", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000, "COMPLETED"));

    expect(await repo.countByState("ABANDONED")).toBe(0);
  });

  it("records and lists events for a session", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.recordEvent({
      id: "event_1",
      sessionId: "session_1",
      type: "DISTRACTION_ATTEMPT",
      occurredAt: 1500,
      hostname: "youtube.com",
    });
    await repo.recordEvent({
      id: "event_2",
      sessionId: "session_2",
      type: "SESSION_COMPLETED",
      occurredAt: 2000,
    });

    const events = await repo.listEvents("session_1");
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("event_1");
  });

  it("clearAll wipes every session and every event, regardless of which session they belong to", async () => {
    const repo = new IndexedDbSessionRepository();
    await repo.archive(buildSession("session_1", 1000, "COMPLETED"));
    await repo.archive(buildSession("session_2", 2000, "ABANDONED"));
    await repo.recordEvent({
      id: "event_1",
      sessionId: "session_1",
      type: "DISTRACTION_ATTEMPT",
      occurredAt: 1500,
      hostname: "youtube.com",
    });

    await repo.clearAll();

    expect(await repo.listHistory()).toEqual([]);
    expect(await repo.countByState("COMPLETED")).toBe(0);
    expect(await repo.countByState("ABANDONED")).toBe(0);
    expect(await repo.listEvents("session_1")).toEqual([]);
  });
});
