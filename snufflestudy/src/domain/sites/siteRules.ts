import type { StudySession, RestrictionMode } from "../session/sessionTypes";
import { isHostnameInList } from "./hostnameMatching";

export type SiteClassification = "ALLOWED" | "BLOCKED" | "UNKNOWN" | "UNAVAILABLE";

export function classifySite(session: StudySession, hostname: string | null): SiteClassification {
  if (hostname === null) return "UNAVAILABLE";
  if (isHostnameInList(hostname, session.allowedSites)) return "ALLOWED";
  if (isHostnameInList(hostname, session.restrictedSites)) return "BLOCKED";
  return "UNKNOWN";
}

export function restrictionModeFor(session: StudySession, hostname: string): RestrictionMode {
  return session.siteRestrictionOverrides?.[hostname] ?? session.restrictionMode;
}
