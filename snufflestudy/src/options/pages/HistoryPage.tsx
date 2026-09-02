import { useEffect, useMemo, useState } from "react";
import type { HistoryQuery, SessionEvent, SessionEventType, StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { useRegisterRefresh } from "../../sidepanel/refresh/RefreshRegistryContext";
import { Input } from "../../sidepanel/components/ui/Input";
import { ButtonBool } from "../../sidepanel/components/ui/ButtonBool";
import { ButtonIcon } from "../../sidepanel/components/ui/ButtonIcon";

type ArchivedState = "COMPLETED" | "ABANDONED";
type StateFilter = ArchivedState | "";

// Without a "From" date (the default on page load, and after clearing the filter), an unbounded
// HistoryQuery would fetch every archived session from IndexedDB and send them all over the
// extension message channel on every load/filter change, only to trim the result client-side
// for the "To" date. HistoryQuery.limit already exists for exactly this - 500 sessions is a
// generous bound for "every session run since install is browsable" (multiple sessions a day
// for well over a year) while keeping each query response bounded.
export const HISTORY_LIST_LIMIT = 500;

const EVENT_LABELS: Record<SessionEventType, string> = {
  SESSION_CREATED: "Session created",
  SESSION_STARTED: "Session started",
  SESSION_PAUSED: "Session paused",
  SESSION_RESUMED: "Session resumed",
  SESSION_BREAK_STARTED: "Break started",
  SESSION_BREAK_ENDED: "Break ended",
  DISTRACTION_ATTEMPT: "Distraction attempt",
  SITE_MARKED_STUDY_RELATED: "Site marked study-related",
  HARD_BLOCK_UNLOCK: "Hard block unlocked",
  RECOVERY: "Recovery",
  SESSION_COMPLETED: "Session completed",
  SESSION_ABANDONED: "Session abandoned",
  USER_WENT_IDLE: "Went idle",
  USER_RETURNED_FROM_IDLE: "Returned from idle",
};

function startOfDayTimestamp(dateStr: string): number | undefined {
  if (!dateStr) return undefined;
  const ms = new Date(`${dateStr}T00:00:00`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function endOfDayTimestamp(dateStr: string): number | undefined {
  if (!dateStr) return undefined;
  const ms = new Date(`${dateStr}T23:59:59.999`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function formatTimestamp(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toLocaleString();
}

function formatDuration(startedAt: number | undefined, endedAt: number | undefined): string {
  if (startedAt === undefined || endedAt === undefined) return "—";
  const totalSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function HistoryPage() {
  const [stateFilter, setStateFilter] = useState<StateFilter>("");
  const [sinceDate, setSinceDate] = useState("");
  const [untilDate, setUntilDate] = useState("");

  const [sessions, setSessions] = useState<StudySession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [eventsBySession, setEventsBySession] = useState<Record<string, SessionEvent[]>>({});
  const [eventsErrorBySession, setEventsErrorBySession] = useState<Record<string, string>>({});
  const [loadingEventsFor, setLoadingEventsFor] = useState<string | null>(null);

  // v4.1 Task 10: extracted out of its own effect below so frame-time-period's own button-bool
  // has a real action (force a fresh fetch of the current filters, e.g. to check for a session
  // that just completed) instead of a dead decoration, and so this page can register with the
  // refresh registry - unlike every other Refresh-registered panel, this page had never done so
  // before this task. Safe to call unconditionally even from OptionsApp.tsx's standalone usage
  // (no RefreshRegistryProvider there) - useRegisterRefresh() itself already no-ops outside one.
  function loadHistory() {
    setSessions(null);
    setLoadError(null);

    const query: HistoryQuery = { limit: HISTORY_LIST_LIMIT };
    const since = startOfDayTimestamp(sinceDate);
    if (since !== undefined) query.since = since;
    if (stateFilter) query.state = stateFilter;

    sendMessage<{ ok: boolean; sessions?: StudySession[]; error?: string }>({
      type: "SESSION_LIST_HISTORY",
      payload: query,
    })
      .then((res) => {
        if (!res.ok || !res.sessions) {
          setLoadError(res.error ?? "Could not load session history.");
          return;
        }
        setSessions(res.sessions);
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated. Surface it instead of leaving the page stuck on
        // "Loading…" forever with no signal.
        console.error("Failed to load session history", err);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }
  useRegisterRefresh(loadHistory);

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateFilter, sinceDate]);

  // `until` isn't part of HistoryQuery (v1's listHistory only supports `since`/`state`/`limit`),
  // so the end-of-range bound is applied client-side over whatever `since`/`state` already
  // fetched, rather than adding a new query parameter to the repository.
  const visibleSessions = useMemo(() => {
    if (!sessions) return sessions;
    const until = endOfDayTimestamp(untilDate);
    if (until === undefined) return sessions;
    return sessions.filter((session) => session.createdAt <= until);
  }, [sessions, untilDate]);

  async function toggleExpand(sessionId: string) {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);
    if (eventsBySession[sessionId]) return;

    setLoadingEventsFor(sessionId);
    setEventsErrorBySession((prev) => {
      const { [sessionId]: _removed, ...rest } = prev;
      return rest;
    });

    try {
      const res = await sendMessage<{ ok: boolean; events?: SessionEvent[]; error?: string }>({
        type: "SESSION_LIST_EVENTS",
        payload: { sessionId },
      });
      if (!res.ok || !res.events) {
        setEventsErrorBySession((prev) => ({
          ...prev,
          [sessionId]: res.error ?? "Could not load this session's event log.",
        }));
        return;
      }
      setEventsBySession((prev) => ({ ...prev, [sessionId]: res.events! }));
    } catch (err) {
      // Same rationale as the listHistory fetch above — sendMessage can reject.
      console.error("Failed to load session events", err);
      setEventsErrorBySession((prev) => ({
        ...prev,
        [sessionId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setLoadingEventsFor(null);
    }
  }

  return (
    <div className="history-page">
      <h2 className="sp-card__title">History</h2>
      <h3 className="sp-label">Session History</h3>

      <div className="history-page__filters">
        <Input
          type="date"
          aria-label="From date"
          value={sinceDate}
          onChange={(e) => setSinceDate(e.target.value)}
        />
        <span className="sp-label">to</span>
        <Input
          type="date"
          aria-label="To date"
          value={untilDate}
          onChange={(e) => setUntilDate(e.target.value)}
        />
        <Input
          variant="dropdown"
          aria-label="Status filter"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as StateFilter)}
        >
          <option value="">All</option>
          <option value="COMPLETED">Completed</option>
          <option value="ABANDONED">Abandoned</option>
        </Input>
        {/* No new save semantics - the filters above already re-query reactively on every
            change. This just gives frame-time-period's own button-bool a real (if redundant)
            action: force a fresh fetch of the current filters, rather than rendering it as a
            dead decoration. Doubles as the Header Refresh button's hookup for this page - see
            loadHistory()'s own header comment. */}
        <ButtonBool icon="check" aria-label="Refresh session history" onClick={loadHistory} />
      </div>

      {loadError && (
        <p role="alert">Couldn't load session history: {loadError}. Please try again.</p>
      )}

      {!loadError && visibleSessions === null && <p>Loading…</p>}

      {!loadError && visibleSessions !== null && visibleSessions.length === 0 && (
        <p className="sp-text-3">No sessions match these filters</p>
      )}

      {!loadError && visibleSessions !== null && visibleSessions.length > 0 && (
        <ul className="history-page__sessions">
          {visibleSessions.map((session) => {
            const expanded = expandedSessionId === session.id;
            return (
              <li key={session.id} className="history-page__session">
                <div className="history-page__session-summary-row">
                  <button
                    type="button"
                    className="history-page__session-summary"
                    aria-expanded={expanded}
                    onClick={() => void toggleExpand(session.id)}
                  >
                    <span className="history-page__session-goal-date">
                      <span className="history-page__session-goal">{session.goal}</span>
                      {" - "}
                      {formatTimestamp(session.createdAt)}
                    </span>
                    <span className="history-page__session-state">{session.state}</span>
                    <span className="history-page__session-duration">
                      {formatDuration(session.startedAt, session.endedAt)}
                    </span>
                  </button>
                  <ButtonIcon
                    icon="options"
                    aria-label="Session options"
                    onClick={() => void toggleExpand(session.id)}
                  />
                </div>

                {expanded && (
                  <div className="history-page__events">
                    <dl>
                      <dt>Distraction attempts</dt>
                      <dd>{session.distractionAttempts}</dd>
                      <dt>Recoveries</dt>
                      <dd>{session.recoveries}</dd>
                    </dl>

                    {loadingEventsFor === session.id && <p>Loading events…</p>}

                    {eventsErrorBySession[session.id] && (
                      <p role="alert">
                        Couldn't load this session's event log: {eventsErrorBySession[session.id]}.
                        Please try again.
                      </p>
                    )}

                    {eventsBySession[session.id] && (
                      <>
                        {eventsBySession[session.id]!.length === 0 ? (
                          <p>No events recorded for this session.</p>
                        ) : (
                          // Rendered as a flat chronological list rather than paired up (e.g.
                          // idle/returned intervals) — a chrome.idle idle→locked transition can
                          // record two consecutive USER_WENT_IDLE events with no
                          // USER_RETURNED_FROM_IDLE in between, so these event types don't
                          // always alternate and must not be assumed to.
                          <ol className="history-page__event-list">
                            {[...eventsBySession[session.id]!]
                              .sort((a, b) => a.occurredAt - b.occurredAt)
                              .map((event) => (
                                <li key={event.id}>
                                  <span className="history-page__event-time">
                                    {formatTimestamp(event.occurredAt)}
                                  </span>{" "}
                                  <span className="history-page__event-label">
                                    {EVENT_LABELS[event.type]}
                                  </span>
                                  {event.hostname && (
                                    <span className="history-page__event-hostname"> — {event.hostname}</span>
                                  )}
                                  {event.reason && (
                                    <span className="history-page__event-reason"> ({event.reason})</span>
                                  )}
                                </li>
                              ))}
                          </ol>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
