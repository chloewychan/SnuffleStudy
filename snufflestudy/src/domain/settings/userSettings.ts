export type TrackingTier = "activity-only" | "detailed";

// v2 Task 10, Part C: a local, device-only "don't show me a toast between these hours" window,
// in the device's local time (0-23, hour-of-day). NOT server-enforced - see UserSettings'
// quietHours field comment for why this whole trio of fields has no RLS/backend component at all,
// unlike Part B's five share_* toggles.
export interface QuietHours {
  startHour: number; // 0-23, inclusive
  endHour: number; // 0-23, exclusive
}

// Whether `date` (defaults to now) falls within the given quiet-hours window, in local time.
// `startHour === endHour` is treated as "no restriction" (a zero-width window is almost certainly
// a misconfiguration, not an intentional "quiet all day" - the UI never produces this on its own,
// but a stray SETTINGS_SAVE payload could) rather than either "always quiet" or "never quiet",
// both of which would silently do something the user didn't ask for. `startHour > endHour` wraps
// past midnight (e.g. 22 -> 7 means quiet from 10pm through 6:59am).
export function isWithinQuietHours(quietHours: QuietHours | null, date: Date = new Date()): boolean {
  if (!quietHours) return false;
  const { startHour, endHour } = quietHours;
  if (startHour === endHour) return false;
  const hour = date.getHours();
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

export interface UserSettings {
  pressureProfileId: string;
  trackingTier: TrackingTier;
  // Gates whether chrome.idle wiring actually runs while trackingTier is "activity-only" (v2
  // Decision 3 in docs/V2_Scope_Summary.md) - activity-only is not a new tri-state tier, this
  // is a sub-toggle within it. Irrelevant while trackingTier is "detailed".
  activityTrackingEnabled: boolean;
  defaultFocusDurationSeconds: number;
  defaultBreakDurationSeconds: number;
  defaultAllowedSites: string[];
  defaultRestrictedSites: string[];
  defaultRestrictionMode: "soft" | "hard";
  onboardingCompleted: boolean;
  // v2 Task 6: gates whether session lifecycle transitions get synced to session_status_events
  // at all (messageRouter.ts's recordFriendStatusEvent / alarmHandlers.ts's natural-completion
  // path check this before ever touching Supabase). Defaults to false, unlike
  // activityTrackingEnabled's true-by-default: that flag only affects local chrome.idle
  // wiring, while this one syncs session activity to a remote backend readable by an entire
  // friend group (subject to session_status_events' RLS visibility rules) - the more
  // privacy-sensitive of the two, so it's opt-in rather than on-by-default.
  friendSyncEnabled: boolean;
  // v2 Task 10, Part C: notification-preference toggles, layered on TOP of the per-friendship
  // server-side settings (friendship_settings' receive_live_nudges/receive_daily_digest - Tasks
  // 7/9) rather than replacing them. These three fields are fundamentally different from Part B's
  // five share_* columns: they gate whether THIS DEVICE displays a chrome.notifications toast for
  // data it has already legitimately received (per-friend-poll, see alarmHandlers.ts's
  // pollNudgeUpdates/pollDigestUpdates), not whether data is accessible at all. There is no
  // security/privacy boundary here - unlike Part B, where the DoD requires the read to fail or
  // omit the field server-side, these are deliberately NOT enforced via RLS or any backend
  // mechanism; a toggle here only ever changes local UI behavior. Both default true (matching
  // this app's existing "loud by default, friend already opted the relationship in via
  // friendship_settings" behavior, unaffected until this task) - quietHours defaults to null (no
  // window configured, i.e. no suppression by time of day).
  liveNudgesNotificationsEnabled: boolean;
  digestNotificationsEnabled: boolean;
  quietHours: QuietHours | null;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  pressureProfileId: "strict-coach",
  trackingTier: "activity-only",
  activityTrackingEnabled: true,
  defaultFocusDurationSeconds: 1500,
  defaultBreakDurationSeconds: 300,
  defaultAllowedSites: [],
  defaultRestrictedSites: [],
  defaultRestrictionMode: "soft",
  onboardingCompleted: false,
  friendSyncEnabled: false,
  liveNudgesNotificationsEnabled: true,
  digestNotificationsEnabled: true,
  quietHours: null,
};
