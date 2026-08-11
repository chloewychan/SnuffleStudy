import { useState, type FormEvent } from "react";
import type { UserSettings } from "../../domain/settings/userSettings";
import { PRESSURE_PROFILES } from "../../domain/pressure/pressureProfiles";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { requestHardBlockHostPermission } from "../../infrastructure/browser/permissionsApi";

interface SessionSetupFormProps {
  settings: UserSettings;
}

export function SessionSetupForm({ settings }: SessionSetupFormProps) {
  const [goal, setGoal] = useState("");
  const [focusMinutes, setFocusMinutes] = useState(settings.defaultFocusDurationSeconds / 60);
  const [pressureProfileId, setPressureProfileId] = useState(settings.pressureProfileId);
  const [restrictionMode, setRestrictionMode] = useState(settings.defaultRestrictionMode);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (restrictionMode === "hard" && settings.defaultRestrictedSites.length > 0) {
        const granted = await requestHardBlockHostPermission(settings.defaultRestrictedSites);
        if (!granted) {
          setError(
            "Hard-mode blocking needs permission to act on your restricted sites. Grant it to start a hard-restricted session, or switch to soft mode."
          );
          return;
        }
      }

      const createResponse = await sendMessage<{
        ok: boolean;
        session?: { id: string };
        errors?: string[];
      }>({
        type: "SESSION_CREATE",
        payload: {
          goal,
          focusDurationSeconds: focusMinutes * 60,
          breakDurationSeconds: settings.defaultBreakDurationSeconds,
          pressureProfileId,
          allowedSites: settings.defaultAllowedSites,
          restrictedSites: settings.defaultRestrictedSites,
          restrictionMode,
        },
      });

      if (!createResponse.ok || !createResponse.session) {
        setError(createResponse.errors?.join(" ") ?? "Could not create session.");
        return;
      }

      await sendMessage({ type: "SESSION_START", payload: { sessionId: createResponse.session.id } });
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated. Surface it via the existing `error` state
      // instead of throwing from the form's onSubmit handler and leaving the button
      // silently doing nothing.
      console.error("Failed to start session", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="session-setup-form" onSubmit={handleSubmit}>
      <label>
        Goal
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Finish 20 chemistry problems"
        />
      </label>
      <label>
        Focus duration (minutes)
        <input
          type="number"
          min={5}
          max={180}
          value={focusMinutes}
          onChange={(e) => setFocusMinutes(Number(e.target.value))}
        />
      </label>
      <label>
        Pressure style
        <select value={pressureProfileId} onChange={(e) => setPressureProfileId(e.target.value)}>
          {PRESSURE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Restriction mode</legend>
        <label>
          <input
            type="radio"
            checked={restrictionMode === "soft"}
            onChange={() => setRestrictionMode("soft")}
          />
          Soft — nudge and escalate
        </label>
        <label>
          <input
            type="radio"
            checked={restrictionMode === "hard"}
            onChange={() => setRestrictionMode("hard")}
          />
          Hard — passcode required
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Starting…" : "Start session"}
      </button>
    </form>
  );
}
