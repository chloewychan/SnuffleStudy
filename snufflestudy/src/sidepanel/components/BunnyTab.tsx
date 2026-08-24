import { useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { Profile } from "../../infrastructure/backend/profileApi";

// Stub data - no backend exists for bunny stats yet (confirmed during planning). Local
// component state only; nothing here is persisted or sent via sendMessage.
const STUB_METERS = [
  { label: "Happiness", percent: 85 },
  { label: "Productivity", percent: 62 },
  { label: "Friendliness", percent: 79 },
];

// v3.3 Task 8: bunnyName/humanName used to be pure local stub state (no persistence, no backend -
// confirmed directly against the pre-Task-8 repo). Now backed by the real `profiles` table via
// PROFILE_GET_MINE/PROFILE_SAVE_MINE (infrastructure/backend/profileApi.ts,
// background/messageRouter.ts). These two defaults are kept as exactly what a signed-in user with
// no profiles row yet sees (a brand-new account, or one that's simply never saved from this tab) -
// not placeholder-only UI anymore, a real fallback state the plan's own DoD calls out ("a user
// with no profile row yet still renders correctly everywhere").
const DEFAULT_BUNNY_NAME = "Snuffles";
const DEFAULT_HUMAN_NAME = "Hooman";

// bunny_name is stored and round-trips through THIS component only, per the plan's own scope -
// no other call site in this codebase reads it. human_name is the one of these two fields the
// rest of Task 8 (useDisplayNames.ts and its call sites) actually surfaces elsewhere.
export function BunnyTab() {
  const [bunnyName, setBunnyName] = useState(DEFAULT_BUNNY_NAME);
  const [humanName, setHumanName] = useState(DEFAULT_HUMAN_NAME);
  const [showBunny, setShowBunny] = useState(true);

  // Distinguishes "PROFILE_GET_MINE hasn't resolved yet" from "resolved, no row" - the Save
  // button below is disabled until this is true, so a fast click can't overwrite a real saved
  // name with the stub defaults this component initializes state to before the fetch returns.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // This component had no persistence trigger at all before this task - there is no natural
  // "field changed" moment to save on (unlike e.g. a checkbox toggle) without either saving on
  // every keystroke (noisy, and racy against itself) or debouncing (more moving parts than this
  // tab needs). An explicit Save button, matching this codebase's existing convention for
  // multi-field forms with a deliberate commit step (OptionsApp.tsx's Settings save, AccountPage's
  // various actions), is the implementer's call the plan explicitly leaves open.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    sendMessage<{ ok: boolean; profile?: Profile | null; error?: string }>({
      type: "PROFILE_GET_MINE",
    })
      .then((res) => {
        if (!res.ok) {
          setLoadError(res.error ?? "Could not load your saved names.");
          return;
        }
        // No profiles row yet - the stub defaults this component's state already starts with are
        // exactly the intended fallback, so there's nothing further to apply.
        if (!res.profile) return;
        if (res.profile.bunnyName) setBunnyName(res.profile.bunnyName);
        if (res.profile.humanName) setHumanName(res.profile.humanName);
      })
      .catch((err) => {
        console.error("Failed to load bunny/human names", err);
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoaded(true));
  }, []);

  function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    sendMessage<{ ok: boolean; profile?: Profile; error?: string }>({
      type: "PROFILE_SAVE_MINE",
      payload: { humanName, bunnyName },
    })
      .then((res) => {
        if (!res.ok) {
          setSaveError(res.error ?? "Could not save your names.");
          return;
        }
        setSaved(true);
      })
      .catch((err) => {
        console.error("Failed to save bunny/human names", err);
        setSaveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSaving(false));
  }

  return (
    <div className="sp-tab-content sp-bunny-tab">
      <section className="sp-card sp-bunny-tab__about">
        <h2 className="sp-card__title">About the Bun</h2>
        {loadError && <p role="alert">Couldn't load your saved names: {loadError}.</p>}
        <div className="sp-field">
          <label htmlFor="bunny-name">Bunny Name:</label>
          <input
            id="bunny-name"
            value={bunnyName}
            onChange={(e) => {
              setBunnyName(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <div className="sp-field">
          <label htmlFor="human-name">Human Name:</label>
          <input
            id="human-name"
            value={humanName}
            onChange={(e) => {
              setHumanName(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <button type="button" onClick={handleSave} disabled={saving || !loaded}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saveError && <p role="alert">Couldn't save your names: {saveError}.</p>}
        {saved && !saveError && <p>Saved.</p>}
        <label className="sp-field sp-field--toggle" htmlFor="show-bunny">
          Show Bunny
          <span className="sp-toggle">
            <input
              type="checkbox"
              id="show-bunny"
              className="sp-toggle__input"
              checked={showBunny}
              onChange={(e) => setShowBunny(e.target.checked)}
            />
            <span className="sp-toggle__track">
              <span className="sp-toggle__knob" />
            </span>
          </span>
        </label>
      </section>

      <section className="sp-card sp-bunny-tab__status">
        <h2 className="sp-card__title">Status</h2>
        {STUB_METERS.map(({ label, percent }) => (
          <div key={label} className="sp-meter">
            <span className="sp-meter__label">{label}</span>
            <div className="sp-meter__track">
              <div className="sp-meter__fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
