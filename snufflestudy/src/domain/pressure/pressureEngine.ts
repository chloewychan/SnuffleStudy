import type { InterventionLevel } from "../session/sessionTypes";
import { getPressureProfile } from "./pressureProfiles";

export function pickWarningMessage(
  pressureProfileId: string,
  interventionLevel: InterventionLevel
): string {
  const profile = getPressureProfile(pressureProfileId);
  const pool =
    interventionLevel === "escalated" ? profile.repeatedWarningMessages : profile.firstWarningMessages;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
