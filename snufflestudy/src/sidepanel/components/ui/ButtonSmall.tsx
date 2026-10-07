import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonSmallProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  colour?: "pink" | "beige" | "white";
  children: ReactNode;
}

// Hover is a CSS :hover state per colour, not a prop.
export function ButtonSmall({ colour = "pink", children, ...rest }: ButtonSmallProps) {
  return (
    <button type="button" className={`sp-btn-small sp-btn-small--${colour}`} {...rest}>
      {children}
    </button>
  );
}
