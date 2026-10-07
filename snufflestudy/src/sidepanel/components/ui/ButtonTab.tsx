import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonTabProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "type" | "onClick"> {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

// No hover state - selected/unselected is driven by which tab is active, not mouse hover.
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
