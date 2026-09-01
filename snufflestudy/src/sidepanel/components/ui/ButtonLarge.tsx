import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonLargeProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  children: ReactNode;
}

// design-specs/frames/button-large.json (component set 168:1421). Property=hover is an ON_HOVER
// variant swap (see design-specs/frames/header-bar.json's Log In button) -> :hover, not a prop.
// Property=diabled ([sic], source typo for "disabled") maps onto the native disabled attribute.
export function ButtonLarge({ children, ...rest }: ButtonLargeProps) {
  return (
    <button type="button" className="sp-btn-large" {...rest}>
      {children}
    </button>
  );
}
