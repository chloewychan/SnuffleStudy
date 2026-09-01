import { useEffect, useId, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { Profile } from "../../infrastructure/backend/profileApi";
import { Input } from "./ui/Input";
import { ButtonBool } from "./ui/ButtonBool";

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

  // Distinguishes "PROFILE_GET_MINE hasn't resolved yet" from "resolved, no row" - both Save
  // buttons below are disabled until this is true, so a fast click can't overwrite a real saved
  // name with the stub defaults this component initializes state to before the fetch returns.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // This component had no persistence trigger at all before this task - there is no natural
  // "field changed" moment to save on (unlike e.g. a checkbox toggle) without either saving on
  // every keystroke (noisy, and racy against itself) or debouncing (more moving parts than this
  // tab needs). design-specs/frames/page-bunny.json's own save trigger is a button-bool "check"
  // icon per field, matching this codebase's existing convention for multi-field forms with a
  // deliberate commit step.
  //
  // v4.1 Task 5: split into two independent buttons/state trios so saving one field never shows
  // the other as "Saving..." - both still send { humanName, bunnyName } together via
  // PROFILE_SAVE_MINE (the message contract is unchanged), only the button-owned loading/success/
  // error state is now per-field.
  const [savingBunnyName, setSavingBunnyName] = useState(false);
  const [bunnyNameSaveError, setBunnyNameSaveError] = useState<string | null>(null);
  const [bunnyNameSaved, setBunnyNameSaved] = useState(false);

  const [savingHumanName, setSavingHumanName] = useState(false);
  const [humanNameSaveError, setHumanNameSaveError] = useState<string | null>(null);
  const [humanNameSaved, setHumanNameSaved] = useState(false);

  const idPrefix = useId();
  const bunnyNameFieldId = `${idPrefix}-bunny-name`;
  const humanNameFieldId = `${idPrefix}-human-name`;

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

  function handleSaveBunnyName() {
    setSavingBunnyName(true);
    setBunnyNameSaveError(null);
    setBunnyNameSaved(false);
    sendMessage<{ ok: boolean; profile?: Profile; error?: string }>({
      type: "PROFILE_SAVE_MINE",
      payload: { humanName, bunnyName },
    })
      .then((res) => {
        if (!res.ok) {
          setBunnyNameSaveError(res.error ?? "Could not save your bunny name.");
          return;
        }
        setBunnyNameSaved(true);
      })
      .catch((err) => {
        console.error("Failed to save bunny name", err);
        setBunnyNameSaveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSavingBunnyName(false));
  }

  function handleSaveHumanName() {
    setSavingHumanName(true);
    setHumanNameSaveError(null);
    setHumanNameSaved(false);
    sendMessage<{ ok: boolean; profile?: Profile; error?: string }>({
      type: "PROFILE_SAVE_MINE",
      payload: { humanName, bunnyName },
    })
      .then((res) => {
        if (!res.ok) {
          setHumanNameSaveError(res.error ?? "Could not save your human name.");
          return;
        }
        setHumanNameSaved(true);
      })
      .catch((err) => {
        console.error("Failed to save human name", err);
        setHumanNameSaveError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSavingHumanName(false));
  }

  return (
    <div className="sp-tab-content sp-bunny-tab">
      <section className="sp-card">
        <h2 className="sp-card__title">About the Bun</h2>
        {loadError && <p role="alert">Couldn't load your saved names: {loadError}.</p>}
        <div className="sp-bunny-tab__body">
          <img
            className="sp-bunny-tab__portrait"
            src={chrome.runtime.getURL("sidepanel/bunny.png")}
            alt=""
          />
          <div className="sp-bunny-tab__fields">
            <div className="sp-bunny-tab__field">
              <label htmlFor={bunnyNameFieldId}>Bunny Name:</label>
              <div className="sp-bunny-tab__field-row">
                <Input
                  id={bunnyNameFieldId}
                  value={bunnyName}
                  onChange={(e) => {
                    setBunnyName(e.target.value);
                    setBunnyNameSaved(false);
                  }}
                />
                <ButtonBool
                  icon="check"
                  aria-label={savingBunnyName ? "Saving bunny name…" : "Save bunny name"}
                  onClick={handleSaveBunnyName}
                  disabled={savingBunnyName || !loaded}
                />
              </div>
              {bunnyNameSaveError && (
                <p role="alert">Couldn't save your bunny name: {bunnyNameSaveError}.</p>
              )}
              {bunnyNameSaved && !bunnyNameSaveError && <p>Saved.</p>}
            </div>

            <div className="sp-bunny-tab__field">
              <label htmlFor={humanNameFieldId}>Human Name:</label>
              <div className="sp-bunny-tab__field-row">
                <Input
                  id={humanNameFieldId}
                  value={humanName}
                  onChange={(e) => {
                    setHumanName(e.target.value);
                    setHumanNameSaved(false);
                  }}
                />
                <ButtonBool
                  icon="check"
                  aria-label={savingHumanName ? "Saving human name…" : "Save human name"}
                  onClick={handleSaveHumanName}
                  disabled={savingHumanName || !loaded}
                />
              </div>
              {humanNameSaveError && (
                <p role="alert">Couldn't save your human name: {humanNameSaveError}.</p>
              )}
              {humanNameSaved && !humanNameSaveError && <p>Saved.</p>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
