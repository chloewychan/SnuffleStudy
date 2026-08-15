export type TrackingTier = "activity-only" | "detailed";

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
};
