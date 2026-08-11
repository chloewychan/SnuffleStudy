export type MovementPreference = "free" | "bottom-edge" | "bottom-only" | "static" | "hidden";

export function initialPosition(preference: MovementPreference): { x: number; y: number } {
  switch (preference) {
    case "free":
      return { x: 20, y: 20 };
    case "bottom-edge":
    case "bottom-only":
      return { x: 20, y: window.innerHeight - 120 };
    case "static":
      return { x: window.innerWidth - 140, y: window.innerHeight - 140 };
    case "hidden":
      return { x: -9999, y: -9999 };
  }
}
