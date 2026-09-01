import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonSmallProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  colour?: "pink" | "beige" | "white";
  children: ReactNode;
}

// design-specs/frames/button-small.json (component set 168:1426). Each Colour's Property=hover is
// an ON_HOVER variant swap -> :hover, not a prop.
export function ButtonSmall({ colour = "pink", children, ...rest }: ButtonSmallProps) {
  return (
    <button type="button" className={`sp-btn-small sp-btn-small--${colour}`} {...rest}>
      {children}
    </button>
  );
}
