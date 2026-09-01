import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonTabProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "type" | "onClick"> {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

// design-specs/frames/button-tab.json (component set 173:1598 - "Propery" is a source typo for
// "Property"). No ON_HOVER interaction is defined on this component set; selected/unselected is
// driven by which tab is active, not mouse hover.
export function ButtonTab({ selected = false, onClick, children, ...rest }: ButtonTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={`sp-btn-tab${selected ? " sp-btn-tab--selected" : ""}`}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}
