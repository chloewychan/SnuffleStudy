import type { KeyboardEvent } from "react";

interface ButtonListProps {
  shape?: "circle" | "square";
  colour?: "white" | "pink" | "beige";
  selected?: boolean;
  onClick?: () => void;
  // "checkbox" for real boolean-state use cases (e.g. task completion, where aria-checked/
  // toBeChecked() semantics matter) - "button" (default) for a generic toggle/decorative marker.
  role?: "button" | "checkbox";
  "aria-label"?: string;
}

// design-specs/frames/button-list.json (component set 168:1437) - a plain colored marker/bullet
// shape, no icon or text content. Two of its six ON_HOVER destinations are mismatched in the spec
// (square/white points at circle/white's hover variant; square/beige points at square/pink's), both
// clearly Figma authoring slips rather than an intended cross-shape/cross-colour hover - every
// combination gets the same treatment as its correctly-linked siblings: default's 75% opacity goes
// to 100% on hover, matching its own shape and colour.
export function ButtonList({
  shape = "circle",
  colour = "white",
  selected = false,
  onClick,
  role = "button",
  "aria-label": ariaLabel,
}: ButtonListProps) {
  function handleKeyDown(e: KeyboardEvent<HTMLSpanElement>) {
    if (!onClick) return;
    // A <span role="button"|"checkbox"> gets no native Enter/Space activation.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <span
      className={`sp-btn-list sp-btn-list--${shape} sp-btn-list--${colour}${
        selected ? " sp-btn-list--selected" : ""
      }`}
      onClick={onClick}
      onKeyDown={onClick ? handleKeyDown : undefined}
      role={onClick ? role : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel}
      {...(onClick
        ? role === "checkbox"
          ? { "aria-checked": selected }
          : { "aria-pressed": selected }
        : {})}
    />
  );
}
