import type { ExtensionMessage } from "../shared/messages";
import { ChromeStorageRepository } from "../infrastructure/storage/chromeStorageRepository";
import { IndexedDbSessionRepository } from "../infrastructure/storage/indexedDbRepository";
import * as machine from "../domain/session/sessionMachine";
import { validateCreateSessionInput } from "../domain/session/sessionValidation";
import { classifySite } from "../domain/sites/siteRules";
import { createHardBlockCredential, verifyPasscode } from "../domain/sites/hardBlockCredential";
import { scheduleSessionAlarm, cancelSessionAlarm } from "../infrastructure/browser/alarmsApi";
import { syncHardBlockRules, clearHardBlockRules } from "../infrastructure/browser/declarativeNetRequestApi";

const settingsRepo = new ChromeStorageRepository();
const historyRepo = new IndexedDbSessionRepository();

function newId(): string {
  return crypto.randomUUID();
}

async function requireActiveSession(sessionId: string) {
  const session = await settingsRepo.getActiveSession();
  if (!session || session.id !== sessionId) {
    throw new Error(`No active session with id ${sessionId}`);
  }
  return session;
}

export async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  const now = Date.now();

  try {
    return await routeMessage(message, now);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function routeMessage(message: ExtensionMessage, now: number): Promise<unknown> {
  switch (message.type) {
    case "SESSION_CREATE": {
      const validation = validateCreateSessionInput(message.payload);
      if (!validation.valid) return { ok: false, errors: validation.errors };
      const session = machine.createSession(message.payload, newId(), now);
      await settingsRepo.saveActiveSession(session);
      return { ok: true, session };
    }

    case "SESSION_START": {
      const session = await requireActiveSession(message.payload.sessionId);
      const started = machine.startSession(session, now);
      await settingsRepo.saveActiveSession(started);
      scheduleSessionAlarm(started.plannedEndAt!);
      if (started.restrictionMode === "hard") {
        await syncHardBlockRules(started.restrictedSites);
      }
      return { ok: true, session: started };
    }

    case "SESSION_PAUSE": {
      const session = await requireActiveSession(message.payload.sessionId);
      const paused = machine.pauseSession(session, now);
      await settingsRepo.saveActiveSession(paused);
      cancelSessionAlarm();
      return { ok: true, session: paused };
    }

    case "SESSION_RESUME": {
      const session = await requireActiveSession(message.payload.sessionId);
      const resumed = machine.resumeSession(session, now);
      await settingsRepo.saveActiveSession(resumed);
      scheduleSessionAlarm(resumed.plannedEndAt!);
      return { ok: true, session: resumed };
    }

    case "SESSION_START_BREAK": {
      const session = await requireActiveSession(message.payload.sessionId);
      const onBreak = machine.startBreak(session, now);
      await settingsRepo.saveActiveSession(onBreak);
      scheduleSessionAlarm(onBreak.breakEndsAt!);
      return { ok: true, session: onBreak };
    }

    case "SESSION_END_BREAK": {
      const session = await requireActiveSession(message.payload.sessionId);
      const focusing = machine.endBreak(session, now);
      await settingsRepo.saveActiveSession(focusing);
      scheduleSessionAlarm(focusing.plannedEndAt!);
      return { ok: true, session: focusing };
    }

    case "SESSION_END": {
      // A SESSION_END message is always a user-initiated early/manual stop
      // (e.g. an "End Session" button). Natural, timer-driven completion is
      // handled entirely by alarmHandlers.ts, which calls completeSession
      // directly and never routes through this handler. So ending via
      // message is always an abandonment, regardless of the session's
      // current state (FOCUSING, PAUSED, BREAK, or SESSION_SETUP) —
      // abandonSession is valid from any non-terminal state.
      const session = await requireActiveSession(message.payload.sessionId);
      const ended = machine.abandonSession(session, now);
      await historyRepo.archive(ended);
      await settingsRepo.saveActiveSession(null);
      cancelSessionAlarm();
      await clearHardBlockRules();
      return { ok: true, session: ended };
    }

    case "SESSION_GET_ACTIVE": {
      return { ok: true, session: await settingsRepo.getActiveSession() };
    }

    case "SITE_STATUS_REQUEST": {
      const session = await settingsRepo.getActiveSession();
      if (!session) return { ok: true, classification: "UNKNOWN" };
      return { ok: true, classification: classifySite(session, message.payload.hostname) };
    }

    case "DISTRACTION_ATTEMPT": {
      const session = await requireActiveSession(message.payload.sessionId);
      const updated = machine.recordDistractionAttempt(machine.warnSession(session));
      await settingsRepo.saveActiveSession(updated);
      await historyRepo.recordEvent({
        id: newId(),
        sessionId: session.id,
        type: "DISTRACTION_ATTEMPT",
        occurredAt: now,
        hostname: message.payload.hostname,
      });
      return { ok: true, session: updated };
    }

    case "MARK_SITE_STUDY_RELATED": {
      const session = await requireActiveSession(message.payload.sessionId);
      const updated = { ...session, allowedSites: [...session.allowedSites, message.payload.hostname] };
      await settingsRepo.saveActiveSession(updated);
      await historyRepo.recordEvent({
        id: newId(),
        sessionId: session.id,
        type: "SITE_MARKED_STUDY_RELATED",
        occurredAt: now,
        hostname: message.payload.hostname,
      });
      return { ok: true, session: updated };
    }

    case "HARD_BLOCK_SET_PASSCODE": {
      const credential = await createHardBlockCredential(message.payload.passcode);
      await settingsRepo.saveHardBlockCredential(credential);
      return { ok: true };
    }

    case "HARD_BLOCK_VERIFY_PASSCODE": {
      const credential = await settingsRepo.getHardBlockCredential();
      if (!credential) return { ok: false, error: "No passcode configured." };
      const result = await verifyPasscode(credential, message.payload.passcode, now);
      await settingsRepo.saveHardBlockCredential(result.credential);
      return { ok: result.success };
    }

    case "SETTINGS_GET": {
      return { ok: true, settings: await settingsRepo.getSettings() };
    }

    case "SETTINGS_SAVE": {
      await settingsRepo.saveSettings(message.payload);
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type" };
  }
}
