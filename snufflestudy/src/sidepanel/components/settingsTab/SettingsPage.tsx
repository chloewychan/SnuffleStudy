import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { UserSettings, TrackingTier } from "../../../domain/settings/userSettings";
import { sendMessage } from "../../../infrastructure/messaging/extensionMessenger";
import {
  requestDetailedTrackingPermission,
  revokeDetailedTrackingPermission,
} from "../../../infrastructure/browser/permissionsApi";
import {
  registerOverlayContentScript,
  unregisterOverlayContentScript,
} from "../../../background/contentScriptRegistration";
import TextInput from "../../ui/TextInput";
import IconButton from "../../ui/IconButton";
import ButtonLarge from "../../ui/ButtonLarge";
import bodyStyles from "../../styles/frontend-backup/components/settings/SettingsBody.module.css";
import trackingStyles from "../../styles/frontend-backup/components/settings/TrackingSettings.module.css";
import notificationStyles from "../../styles/frontend-backup/components/settings/NotificationSettings.module.css";
import restrictedStyles from "../../styles/frontend-backup/components/inputs/RestrictedSitesList.module.css";

function asset(name: string) {
  return chrome.runtime.getURL(`sidepanel/assets/${name}`);
}

// v3.3 Task 7: extracted verbatim from OptionsApp.tsx's inline "settings" view - same state
// (settings, trackingChanging, passcode/oldPasscode/etc.), same handlers (updateSettings,
// handleTrackingTierChange, handleSavePasscode), same messages (SETTINGS_GET/SETTINGS_SAVE/
// HARD_BLOCK_SET_PASSCODE). This component is composed by both OptionsApp.tsx (full tab) and the
// sidepanel's SettingsTab.tsx (v4.1 Task 10: one scrolling view of stacked boxes, no sub-nav) -
// one shared source for the Tracking/Friends/Notifications/Default-restricted-sites/Hard-block-
// passcode/Camera-and-microphone UI.
//
// v4.2 Task 11: re-skinned as frontend-backup's SettingsBody.tsx/TrackingSettings.tsx/
// NotificationSettings.tsx/RestrictedSitesList.tsx design. Every hook, handler, and sendMessage()
// call below is unchanged in behavior - only the JSX changed. Two deliberate, plan-mandated
// exceptions to "copy the design's own copy/structure exactly":
//   1. Every visible label/copy string that OptionsApp.test.tsx (a suite this task doesn't touch,
//      since it's out of Task 11's scope and this component is that suite's actual subject via
//      OptionsApp.tsx's own "settings" view) looks up by exact text is kept byte-identical to its
//      pre-v4.2 wording, even where frontend-backup's own copy differs slightly (e.g. "Share
//      session activity with my friends", not the design's "...with friends"; "Save passcode",
//      not "Save Passcode") - changing it would silently weaken real, already-passing coverage of
//      a real Chrome permission flow (tracking-tier) and the hard-block passcode flow, not just
//      break a test's string match.
//   2. Decision 7 (not overridable): "Grant Camera & Microphone Access" now lives here (moved from
//      SettingsTab.tsx's old callout, which this task deletes - see SettingsTab.tsx's own
//      comment) because that's where SettingsBody.tsx's own design puts it. Since this component
//      is also rendered inside OptionsApp.tsx's full-tab "settings" view (unchanged, out of this
//      task's scope), that view now shows this button immediately above its own separate, real
//      Camera & microphone access section (OptionsApp.tsx's own <h2>, unaffected) - a harmless
//      but slightly redundant "open the options page" affordance while already on the options
//      page. Flagged here and in the v4.2 Task 11 report, not silently introduced. Confirmed
//      OptionsApp.test.tsx's "camera & microphone access" describe block still passes unaffected:
//      it looks up the exact, case-sensitive string "Grant camera & microphone access" (lowercase
//      "camera"), which does not collide with this button's own "Grant Camera & Microphone
//      Access" (title case).
//
// QA-discovered bug (v3.3 QA pass): this component owns its OWN settings state, fetched
// independently of SidePanelApp.tsx's own top-level `settings` (passed down to StudyTab ->
// SessionSetupForm, which is what a new session actually gets created with). Saving a change here
// persists it correctly in the background, but never told SidePanelApp's own copy to refresh -
// starting a session right after editing something here (e.g. a restricted site), with no reload
// in between, silently used whatever SidePanelApp had fetched once on mount. `onSettingsSaved` is
// optional specifically so OptionsApp.tsx's own standalone full-tab usage (no sibling state to
// keep in sync there) is unaffected - only SettingsTab.tsx (the sidepanel) passes one through.
export function SettingsPage({
  onSettingsSaved,
}: {
  onSettingsSaved?: (settings: UserSettings) => void;
} = {}): JSX.Element {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [trackingChanging, setTrackingChanging] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [confirmPasscode, setConfirmPasscode] = useState("");
  const [oldPasscode, setOldPasscode] = useState("");
  const [passcodeSaved, setPasscodeSaved] = useState(false);
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [passcodeSaving, setPasscodeSaving] = useState(false);

  // v4.1 Task 10: appends one trimmed, non-empty entry to `settings.defaultRestrictedSites` via
  // the existing `updateSettings` optimistic-save helper below - same convention as every other
  // field in this file, replacing the old free-text textarea (one line per site) with a text
  // input + Add button + a deletable list, matching the scope doc's Settings section.
  const [newRestrictedSite, setNewRestrictedSite] = useState("");

  useEffect(() => {
    let cancelled = false;

    sendMessage<{ ok: boolean; settings: UserSettings }>({ type: "SETTINGS_GET" })
      .then((res) => {
        if (!cancelled) {
          setSettings(res.settings);
          setSettingsError(null);
        }
      })
      .catch((err) => {
        // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
        // connection. Receiving end does not exist." during service-worker startup races,
        // or extension-context-invalidated. This view is gated behind this call succeeding, so
        // surface the failure instead of leaving it stuck on "Loading…" forever with no signal.
        console.error("Failed to load settings", err);
        if (!cancelled) {
          setSettingsError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (settingsError) {
    return (
      <main className={bodyStyles.settingsBody}>
        <p role="alert">Couldn't load your settings: {settingsError}. Please reload this page.</p>
      </main>
    );
  }

  if (!settings) return <main className={bodyStyles.settingsBody}>Loading…</main>;

  async function updateSettings(patch: Partial<UserSettings>) {
    const previous = settings!;
    const next = { ...previous, ...patch };
    // Optimistic update: reflect the change immediately for a responsive UI, but if the
    // save below fails, roll back to what's actually persisted. Without this, a failed
    // save would leave the UI showing a change that silently never made it to storage.
    setSettings(next);
    setSaveError(null);
    try {
      await sendMessage({ type: "SETTINGS_SAVE", payload: next });
      onSettingsSaved?.(next);
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated.
      console.error("Failed to save settings", err);
      setSettings(previous);
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAddRestrictedSite() {
    const trimmed = newRestrictedSite.trim();
    if (!trimmed) return;
    updateSettings({ defaultRestrictedSites: [...settings!.defaultRestrictedSites, trimmed] });
    setNewRestrictedSite("");
  }

  function handleDeleteRestrictedSite(site: string) {
    updateSettings({
      defaultRestrictedSites: settings!.defaultRestrictedSites.filter((s) => s !== site),
    });
  }

  async function handleTrackingTierChange(tier: TrackingTier) {
    setTrackingChanging(true);
    setSaveError(null);
    try {
      if (tier === "detailed") {
        const granted = await requestDetailedTrackingPermission();
        if (!granted) return;
        try {
          await registerOverlayContentScript();
        } catch (err) {
          // Registering the dynamic overlay content script (chrome.scripting.
          // registerContentScripts) is best-effort: the permission grant and tier switch
          // below are the part the user actually asked for and should still go through even
          // if this fails. A failure here just means the Snuffles overlay won't appear until
          // it's retried (e.g. toggling the tier again) — not worth rolling back the whole
          // change or blocking the save over, so it's logged rather than surfaced as
          // `saveError`.
          console.error("Failed to register overlay content script", err);
        }
      } else {
        await revokeDetailedTrackingPermission();
        try {
          await unregisterOverlayContentScript();
        } catch (err) {
          // Same best-effort rationale as registerOverlayContentScript above.
          console.error("Failed to unregister overlay content script", err);
        }
      }
      await updateSettings({ trackingTier: tier });
    } catch (err) {
      // requestDetailedTrackingPermission / revokeDetailedTrackingPermission
      // (chrome.permissions.request/remove) can reject — e.g. extension-context-invalidated.
      console.error("Failed to change tracking tier", err);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrackingChanging(false);
    }
  }

  async function handleSavePasscode() {
    setPasscodeSaving(true);
    setPasscodeError(null);
    try {
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: "HARD_BLOCK_SET_PASSCODE",
        payload: { passcode, oldPasscode: oldPasscode || undefined },
      });
      if (!response.ok) {
        // The backend distinguishes "no credential yet" from "wrong/missing current passcode"
        // via this error message - the frontend has no cheap way to know in advance whether a
        // credential already exists without a separate round-trip, so it always renders the
        // old-passcode field and lets the backend's response drive the error state.
        setPasscodeError(response.error ?? "Couldn't save your passcode.");
        return;
      }
      setPasscode("");
      setConfirmPasscode("");
      setOldPasscode("");
      setPasscodeSaved(true);
    } catch (err) {
      // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
      // connection. Receiving end does not exist." during service-worker startup races,
      // or extension-context-invalidated. Surface it so the user isn't left unsure whether
      // their hard-block passcode actually saved.
      console.error("Failed to save hard-block passcode", err);
      setPasscodeError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasscodeSaving(false);
    }
  }

  function handleOpenOptionsPage() {
    // Decision 7 (not overridable): Chrome's getUserMedia permission prompt can never be shown
    // from the sidepanel at all - this just opens the real Options tab, which has the actual
    // grant flow (OptionsApp.tsx's own still-inline Camera & microphone access section).
    //
    // Standing convention in this codebase (see Header.tsx's "Fix 6" comment): never leave an
    // async call triggered from a UI handler unhandled. chrome.runtime.openOptionsPage() returns
    // a Promise that can reject (e.g. extension-context-invalidated) - Promise.resolve(...) also
    // normalizes a test mock's openOptionsPage() returning undefined instead of a real Promise.
    void Promise.resolve(chrome.runtime.openOptionsPage()).catch((err) =>
      console.error("Failed to open the options page", err)
    );
  }

  return (
    <main className={bodyStyles.settingsBody}>
      <h2 className={bodyStyles.general}>General</h2>

      <section className={trackingStyles.trackingSettings}>
        <h3 className={trackingStyles.tracking}>Tracking</h3>
        <div className={trackingStyles.listItem}>
          <input
            id="tracking-tier-activity-only"
            type="radio"
            name="tracking-tier"
            className={trackingStyles.buttonList}
            checked={settings.trackingTier === "activity-only"}
            onChange={() => handleTrackingTierChange("activity-only")}
            disabled={trackingChanging}
          />
          <label htmlFor="tracking-tier-activity-only" className={trackingStyles.activityOnly}>
            Activity-only
          </label>
        </div>
        <div className={trackingStyles.listItem2}>
          <input
            id="tracking-tier-detailed"
            type="radio"
            name="tracking-tier"
            className={trackingStyles.buttonList2}
            checked={settings.trackingTier === "detailed"}
            onChange={() => handleTrackingTierChange("detailed")}
            disabled={trackingChanging}
          />
          <label htmlFor="tracking-tier-detailed" className={trackingStyles.activityOnly}>
            Detailed site tracking
          </label>
        </div>
        <div className={trackingStyles.listItem3}>
          <input
            id="activity-tracking-enabled"
            type="checkbox"
            className={trackingStyles.buttonList3}
            checked={settings.activityTrackingEnabled}
            disabled={settings.trackingTier !== "activity-only"}
            onChange={(e) => updateSettings({ activityTrackingEnabled: e.target.checked })}
          />
          <label htmlFor="activity-tracking-enabled" className={trackingStyles.activityOnly}>
            Track idle/active status during focus sessions
          </label>
        </div>
      </section>

      <section className={bodyStyles.frameFriends}>
        <h3 className={bodyStyles.friends}>Friends</h3>
        <div className={bodyStyles.listItem}>
          <input
            id="friend-sync-enabled"
            type="checkbox"
            className={bodyStyles.buttonList}
            checked={settings.friendSyncEnabled}
            onChange={(e) => updateSettings({ friendSyncEnabled: e.target.checked })}
          />
          <label htmlFor="friend-sync-enabled" className={bodyStyles.friends}>
            Share session activity with my friends
          </label>
        </div>
      </section>

      <section className={notificationStyles.notificationSettings}>
        <h3 className={notificationStyles.notifications}>Notifications</h3>
        <div className={notificationStyles.listItem}>
          <input
            id="live-nudges-notifications-enabled"
            type="checkbox"
            className={notificationStyles.buttonListIcon}
            checked={settings.liveNudgesNotificationsEnabled}
            onChange={(e) =>
              updateSettings({ liveNudgesNotificationsEnabled: e.target.checked })
            }
          />
          <label
            htmlFor="live-nudges-notifications-enabled"
            className={notificationStyles.showANotification}
          >
            Show a notification when a friend sends me a live nudge
          </label>
        </div>
        <div className={notificationStyles.listItem2}>
          <input
            id="digest-notifications-enabled"
            type="checkbox"
            className={notificationStyles.buttonListIcon}
            checked={settings.digestNotificationsEnabled}
            onChange={(e) => updateSettings({ digestNotificationsEnabled: e.target.checked })}
          />
          <label
            htmlFor="digest-notifications-enabled"
            className={notificationStyles.showANotification}
          >
            Show a notification for a friend's daily digest
          </label>
        </div>
        <div className={notificationStyles.listItem3}>
          {/* v4.2 Task 11 reconciliation: the design shows a single on/off-implying row rather
              than today's explicit enable-checkbox-then-two-number-fields. Dropping the explicit
              on/off toggle would remove a real state (quietHours: null) the data model
              represents, so this keeps the existing enable/disable checkbox - styled to match the
              new design's own checkbox look - ahead of the two time fields, which only render
              while quiet hours are enabled (unchanged behavior). */}
          <input
            id="quiet-hours-enabled"
            type="checkbox"
            className={notificationStyles.buttonListIcon}
            checked={settings.quietHours !== null}
            onChange={(e) =>
              updateSettings({
                quietHours: e.target.checked ? { startHour: 22, endHour: 7 } : null,
              })
            }
          />
          <label htmlFor="quiet-hours-enabled" className={notificationStyles.showANotification}>
            Quiet hours (suppress notification toasts during a window)
          </label>
          {settings.quietHours && (
            <div className={notificationStyles.timePeriodPicker}>
              <TextInput
                property1="textbox"
                inputHeight="36px"
                inputBorderRadius="15px"
                inputWidth="130px"
                inputFlex="unset"
                entryFieldType="number"
                min={0}
                max={23}
                ariaLabel="Quiet hours start (0-23, local time)"
                value={String(settings.quietHours.startHour)}
                onChange={(e) =>
                  updateSettings({
                    quietHours: {
                      ...settings.quietHours!,
                      startHour: Number(e.target.value),
                    },
                  })
                }
                entryFieldFontFamily="'Shantell Sans'"
                entryFieldDisplay="unset"
                entryFieldBorder="unset"
                entryFieldOutline="unset"
                entryFieldBackgroundColor="unset"
                entryFieldMargin="0"
                entryFieldFontWeight="400"
              />
              <h3 className={notificationStyles.showANotification}>to</h3>
              <TextInput
                property1="textbox"
                inputHeight="36px"
                inputBorderRadius="15px"
                inputWidth="130px"
                inputFlex="unset"
                entryFieldType="number"
                min={0}
                max={23}
                ariaLabel="Quiet hours end (0-23, local time)"
                value={String(settings.quietHours.endHour)}
                onChange={(e) =>
                  updateSettings({
                    quietHours: { ...settings.quietHours!, endHour: Number(e.target.value) },
                  })
                }
                entryFieldFontFamily="'Shantell Sans'"
                entryFieldDisplay="inline-block"
                entryFieldBorder="none"
                entryFieldOutline="none"
                entryFieldBackgroundColor="transparent"
                entryFieldMargin="unset"
                entryFieldFontWeight="unset"
              />
              {/* Purely decorative, matching Header.tsx's own "leave it non-interactive unless
                  you can confirm what it should do" precedent (v4.2 Task 2's close icon): the
                  start/end fields above already save on every change (no separate "confirm"
                  step exists in this data model), so there's no real action for this checkmark
                  to back. */}
              <img
                className={notificationStyles.buttonBoolIcon}
                loading="lazy"
                alt=""
                src={asset("button-check.svg")}
              />
            </div>
          )}
        </div>
      </section>

      <section className={bodyStyles.frameRestrictedSites}>
        <h3 className={bodyStyles.friends}>Restricted Sites</h3>
        <div className={restrictedStyles.restrictedSitesList}>
          <div className={restrictedStyles.inputListItem}>
            <h3 className={restrictedStyles.addSite}>Add Site</h3>
            <TextInput
              property1="textbox"
              placeholder="E.g., link"
              entryFieldType="text"
              ariaLabel="New restricted site"
              value={newRestrictedSite}
              onChange={(e) => setNewRestrictedSite(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddRestrictedSite();
                }
              }}
            />
            <button
              type="button"
              className={restrictedStyles.buttonIconReset}
              onClick={handleAddRestrictedSite}
              disabled={!newRestrictedSite.trim()}
              aria-label="Add"
            >
              <img
                className={restrictedStyles.buttonBoolIcon}
                loading="lazy"
                alt=""
                src={asset("button-check.svg")}
              />
            </button>
          </div>
          {settings.defaultRestrictedSites.length > 0 && (
            <ul className={restrictedStyles.sitesList}>
              {settings.defaultRestrictedSites.map((site) => (
                <li key={site} className={restrictedStyles.exampleListItem}>
                  <h3 className={restrictedStyles.addSite}>{site}</h3>
                  <IconButton
                    icon={asset("icon-trash.svg")}
                    label="Delete"
                    onClick={() => handleDeleteRestrictedSite(site)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {saveError && (
        <p role="alert">Couldn't save your changes: {saveError}. Please try again.</p>
      )}

      <section className={bodyStyles.frameRestrictedSites}>
        <h3 className={bodyStyles.friends}>Hard-Block Passcode</h3>
        <div className={bodyStyles.listItems}>
          <div className={bodyStyles.inputOldPasscode}>
            <h3 className={bodyStyles.friends}>Old Passcode</h3>
            <TextInput
              property1="textbox"
              inputHeight="36px"
              inputBorderRadius="15px"
              inputWidth="unset"
              inputFlex="1"
              placeholder="E.g., Old passcode (leave blank if you've never set one)"
              entryFieldType="password"
              dataTestId="old-passcode-input"
              value={oldPasscode}
              onChange={(e) => setOldPasscode(e.target.value)}
              entryFieldFontFamily="'Shantell Sans'"
              entryFieldDisplay="inline-block"
              entryFieldBorder="none"
              entryFieldOutline="none"
              entryFieldBackgroundColor="transparent"
              entryFieldMargin="unset"
              entryFieldFontWeight="unset"
            />
          </div>
          <div className={bodyStyles.inputOldPasscode}>
            <h3 className={bodyStyles.friends}>New Passcode</h3>
            <TextInput
              property1="textbox"
              inputHeight="36px"
              inputBorderRadius="15px"
              inputWidth="unset"
              inputFlex="1"
              placeholder="E.g., New passcode"
              entryFieldType="password"
              dataTestId="passcode-input"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              entryFieldFontFamily="'Shantell Sans'"
              entryFieldDisplay="inline-block"
              entryFieldBorder="none"
              entryFieldOutline="none"
              entryFieldBackgroundColor="transparent"
              entryFieldMargin="unset"
              entryFieldFontWeight="unset"
            />
          </div>
          <div className={bodyStyles.inputOldPasscode}>
            <h3 className={bodyStyles.friends}>Confirm New</h3>
            <TextInput
              property1="textbox"
              inputHeight="36px"
              inputBorderRadius="15px"
              inputWidth="unset"
              inputFlex="1"
              placeholder="E.g., New passcode"
              entryFieldType="password"
              dataTestId="confirm-passcode-input"
              value={confirmPasscode}
              onChange={(e) => setConfirmPasscode(e.target.value)}
              entryFieldFontFamily="'Shantell Sans'"
              entryFieldDisplay="inline-block"
              entryFieldBorder="none"
              entryFieldOutline="none"
              entryFieldBackgroundColor="transparent"
              entryFieldMargin="unset"
              entryFieldFontWeight="unset"
            />
          </div>
          <ButtonLarge
            property1="default"
            button={passcodeSaving ? "Saving…" : "Save passcode"}
            onClick={handleSavePasscode}
            disabled={passcode.length < 4 || passcode !== confirmPasscode || passcodeSaving}
            buttonLargeBorderRadius="15px"
          />
          {passcodeError && (
            <p role="alert">Couldn't save your passcode: {passcodeError}. Please try again.</p>
          )}
          {passcodeSaved && <p>Passcode saved.</p>}
        </div>
      </section>

      <section className={bodyStyles.frameFriends}>
        <h3 className={bodyStyles.friends}>{`Camera & Microphone`}</h3>
        <div className={bodyStyles.buttonGrantCameraAndMicrop}>
          <ButtonLarge
            property1="default"
            buttonLargeBorderRadius="15px"
            button={`Grant Camera & Microphone Access`}
            buttonFontFamily="'Shantell Sans'"
            buttonMargin="unset"
            buttonFontWeight="unset"
            buttonLargeAlignSelf="unset"
            onClick={handleOpenOptionsPage}
          />
        </div>
      </section>
    </main>
  );
}
