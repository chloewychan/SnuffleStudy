export type TrackingTier = "activity-only" | "detailed";

export interface UserSettings {
  pressureProfileId: string;
  trackingTier: TrackingTier;
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
  defaultFocusDurationSeconds: 1500,
  defaultBreakDurationSeconds: 300,
  defaultAllowedSites: [],
  defaultRestrictedSites: [],
  defaultRestrictionMode: "soft",
  onboardingCompleted: false,
};
