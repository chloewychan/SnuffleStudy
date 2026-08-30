import { useEffect, useMemo, useState } from "react";
import { LocalizationProvider, DatePicker } from "@mui/x-date-pickers";
import { AdapterDateFns } from "@mui/x-date-pickers/AdapterDateFns";
import type { HistoryQuery, SessionEvent, SessionEventType, StudySession } from "../../domain/session/sessionTypes";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import TextSmall from "../../sidepanel/ui/TextSmall";
// v4.2 Task 13: re-skinned as frontend-backup's SessionHistory.tsx design. `sessionHistoryStyles`
// is the ported, byte-for-byte copy of SessionHistory.module.css (Task 1, plus this task's own
// .buttonIconReset addition - see that file's own header comment); `styles` is this task's new
// file for the one piece with no design frame at all (Decision 9) - the expanded per-session event
// log (see HistoryPage.module.css's own header comment).
import sessionHistoryStyles from "../../sidepanel/styles/frontend-backup/components/settings/SessionHistory.module.css";
import styles from "./HistoryPage.module.css";

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

// Design step's own wording: "Goal — Completed — Date" - the design's single "Goal - Date" line
// needs the state folded in too, since the current model always shows all three (Task 13 Steps).
const STATE_LABELS: Record<ArchivedState, string> = {
  COMPLETED: "Completed",
  ABANDONED: "Abandoned",
};

function asset(name: string) {
  return chrome.runtime.getURL(`sidepanel/assets/${name}`);
}

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

const YYYY_MM_DD = /^(\d{4})-(\d{2})-(\d{2})$/;

// Decision 8's own onChange contract: the MUI DatePicker hands back a `Date | null`, but
// sinceDate/untilDate (and the query logic that consumes them - startOfDayTimestamp/
// endOfDayTimestamp above, unchanged) still expect the exact `YYYY-MM-DD` string shape the old
// plain `<input type="date">` produced. Both directions below are written to stay entirely in
// local-calendar-day terms, never routing through UTC, so a picked date never silently shifts by
// one day for a user whose local UTC offset is negative:
//   - dateStringToPickerValue constructs the Date from explicit y/m/d components (`new Date(y, m,
//     d)`, always local midnight) rather than `new Date(dateStr)`, which the ECMAScript spec
//     parses a bare "YYYY-MM-DD" string as *UTC* midnight - the same local-time convention
//     startOfDayTimestamp already uses for this exact string shape (`new Date(`${d}T00:00:00`)`,
//     no zone suffix).
//   - pickerValueToDateString reads the Date's local calendar fields directly
//     (getFullYear/getMonth/getDate), never toISOString()/toJSON(), which convert through UTC
//     first and can roll the date backward a day for any zone with a non-zero UTC offset.
function dateStringToPickerValue(dateStr: string): Date | null {
  const match = YYYY_MM_DD.exec(dateStr);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function pickerValueToDateString(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

  useEffect(() => {
    let cancelled = false;
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
        if (cancelled) return;
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
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
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

  const sinceDateValue = useMemo(() => dateStringToPickerValue(sinceDate), [sinceDate]);
  const untilDateValue = useMemo(() => dateStringToPickerValue(untilDate), [untilDate]);

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
    <section className={sessionHistoryStyles.sessionHistorySection}>
      {/* "Session history" (lowercase "history") is deliberately kept byte-identical to the
          pre-v4.2 heading text, not the design's own "History"/"Session History" copy - both
          OptionsApp.tsx and SettingsTab.tsx (out of this task's scope) look this exact string up
          via screen.findByText("Session history") in their own, already-passing test suites. */}
      <h2 className={sessionHistoryStyles.history}>Session history</h2>

      <LocalizationProvider dateAdapter={AdapterDateFns}>
        <div className={sessionHistoryStyles.sessionHistoryControls}>
          <div className={sessionHistoryStyles.sessionHistoryTimePeriod}>
            <div className={sessionHistoryStyles.input}>
              <DatePicker
                value={sinceDateValue}
                onChange={(newValue) => setSinceDate(pickerValueToDateString(newValue))}
                format="yyyy-MM-dd"
                // The single-native-<input> field structure (rather than the new accessible,
                // multi-section field) - a real, documented MUI x-date-pickers option, chosen
                // here so the field keeps behaving like a normal text input for both keyboard
                // users and this file's own test suite, matching the plain <input type="date">
                // it replaces as closely as this component allows.
                enableAccessibleFieldDOMStructure={false}
                slotProps={{
                  textField: {
                    size: "medium",
                    fullWidth: false,
                    required: false,
                    autoFocus: false,
                    error: false,
                    color: "primary",
                    inputProps: { "aria-label": "From date" },
                  },
                  openPickerIcon: {
                    component: () => <></>,
                  },
                }}
              />
            </div>
            <h3 className={sessionHistoryStyles.sessionHistory}>to</h3>
            <div className={sessionHistoryStyles.input}>
              <DatePicker
                value={untilDateValue}
                onChange={(newValue) => setUntilDate(pickerValueToDateString(newValue))}
                format="yyyy-MM-dd"
                enableAccessibleFieldDOMStructure={false}
                slotProps={{
                  textField: {
                    size: "medium",
                    fullWidth: false,
                    required: false,
                    autoFocus: false,
                    error: false,
                    color: "primary",
                    inputProps: { "aria-label": "To date" },
                  },
                  openPickerIcon: {
                    component: () => <></>,
                  },
                }}
              />
            </div>
            {/* Decorative, matching the design's own static check icon - filtering already
                applies live (via sinceDate/stateFilter's own effect above, and untilDate's own
                client-side memo), so there's no separate "apply filters" step for this icon to
                back. Mirrors Task 11's identical treatment of NotificationSettings.tsx's trailing
                quiet-hours checkmark. */}
            <img className={sessionHistoryStyles.buttonBoolIcon} alt="" src={asset("button-check.svg")} />
          </div>
          <select
            className={sessionHistoryStyles.input3}
            aria-label="Status filter"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
          >
            <option value="">All</option>
            <option value="COMPLETED">Completed</option>
            <option value="ABANDONED">Abandoned</option>
          </select>
        </div>
      </LocalizationProvider>

      {loadError && (
        <p role="alert">Couldn't load session history: {loadError}. Please try again.</p>
      )}

      {!loadError && visibleSessions === null && <TextSmall textbox="Loading…" />}

      {!loadError && visibleSessions !== null && visibleSessions.length === 0 && (
        <TextSmall textbox="No sessions match these filters." />
      )}

      {!loadError && visibleSessions !== null && visibleSessions.length > 0 && (
        <ul className={sessionHistoryStyles.exampleListItems}>
          {visibleSessions.map((session) => {
            const expanded = expandedSessionId === session.id;
            const sortedEvents = eventsBySession[session.id]
              ? [...eventsBySession[session.id]!].sort((a, b) => a.occurredAt - b.occurredAt)
              : undefined;

            return (
              <li key={session.id} className={styles.sessionRow}>
                <div className={sessionHistoryStyles.exampleListItem}>
                  <h3 className={sessionHistoryStyles.sessionHistory}>
                    {session.goal} — {STATE_LABELS[session.state as ArchivedState] ?? session.state} —{" "}
                    {formatTimestamp(session.createdAt)}
                  </h3>
                  <button
                    type="button"
                    className={sessionHistoryStyles.buttonIconReset}
                    aria-expanded={expanded}
                    aria-label={`Toggle details for ${session.goal}`}
                    onClick={() => void toggleExpand(session.id)}
                  >
                    <img
                      className={sessionHistoryStyles.buttonBoolIcon}
                      alt=""
                      src={asset("button-options.svg")}
                    />
                  </button>
                </div>

                {expanded && (
                  <div className={styles.expandedDetails}>
                    <div className={styles.summaryStats}>
                      <TextSmall
                        textbox={`Distraction attempts: ${session.distractionAttempts}`}
                      />
                      <TextSmall textbox={`Recoveries: ${session.recoveries}`} />
                      <TextSmall
                        textbox={`Duration: ${formatDuration(session.startedAt, session.endedAt)}`}
                      />
                    </div>

                    {loadingEventsFor === session.id && (
                      <p className={styles.statusText}>Loading events…</p>
                    )}

                    {eventsErrorBySession[session.id] && (
                      <p role="alert">
                        Couldn't load this session's event log: {eventsErrorBySession[session.id]}.
                        Please try again.
                      </p>
                    )}

                    {sortedEvents && (
                      <>
                        {sortedEvents.length === 0 ? (
                          <p className={styles.statusText}>No events recorded for this session.</p>
                        ) : (
                          // Rendered as a flat chronological list rather than paired up (e.g.
                          // idle/returned intervals) — a chrome.idle idle→locked transition can
                          // record two consecutive USER_WENT_IDLE events with no
                          // USER_RETURNED_FROM_IDLE in between, so these event types don't
                          // always alternate and must not be assumed to.
                          <ol className={styles.eventList}>
                            {sortedEvents.map((event) => (
                              <li key={event.id}>
                                <TextSmall
                                  textbox={
                                    `${formatTimestamp(event.occurredAt)} — ${EVENT_LABELS[event.type]}` +
                                    (event.hostname ? ` — ${event.hostname}` : "") +
                                    (event.reason ? ` (${event.reason})` : "")
                                  }
                                />
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
    </section>
  );
}
