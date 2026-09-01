import type { ReactNode } from "react";

interface TextSmallProps {
  colour?: "white" | "pink";
  children: ReactNode;
}

// design-specs/frames/text-small.json (component set 177:2697)
export function TextSmall({ colour = "white", children }: TextSmallProps) {
  return <span className={`sp-text-small sp-text-small--${colour}`}>{children}</span>;
}
