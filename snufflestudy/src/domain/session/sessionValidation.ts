import type { CreateSessionInput } from "./sessionTypes";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCreateSessionInput(input: CreateSessionInput): ValidationResult {
  const errors: string[] = [];

  if (input.goal.trim().length === 0) errors.push("Goal cannot be empty.");
  if (input.focusDurationSeconds <= 0) errors.push("Focus duration must be greater than zero.");
  if (input.breakDurationSeconds <= 0) errors.push("Break duration must be greater than zero.");
  if (input.pressureProfileId.trim().length === 0) errors.push("A pressure profile must be selected.");

  return { valid: errors.length === 0, errors };
}
