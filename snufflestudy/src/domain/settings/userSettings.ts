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
};
