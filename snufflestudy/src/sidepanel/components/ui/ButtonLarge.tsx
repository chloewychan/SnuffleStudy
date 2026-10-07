import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonLargeProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  children: ReactNode;
}

// Hover is a CSS :hover state, not a prop. The disabled prop maps onto the native disabled
// attribute.
export function ButtonLarge({ children, ...rest }: ButtonLargeProps) {
  return (
    <button type="button" className="sp-btn-large" {...rest}>
      {children}
    </button>
  );
}
