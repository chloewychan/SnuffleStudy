import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { TextSmall } from "./TextSmall";

interface VideoBoxProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    "className" | "onClick" | "children" | "role" | "tabIndex" | "aria-pressed"
  > {
  label: string;
  selected?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}

// The selected/default state is an on-click toggle, not a hover state, so "selected" stays a
// real prop. It reuses this codebase's existing tile-selection treatment
// (.study-room-panel__tile--selected in src/styles/sidepanel.css).
export function VideoBox({ label, selected = false, onClick, children, ...rest }: VideoBoxProps) {
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return;
    // A <div role="button"> (unlike a real <button>) gets no native Enter/Space activation.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      className={`sp-video-box${selected ? " sp-video-box--selected" : ""}`}
      onClick={onClick}
      onKeyDown={onClick ? handleKeyDown : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={onClick ? selected : undefined}
      {...rest}
    >
      <div className="sp-video-box__media">{children}</div>
      <TextSmall colour="white">{label}</TextSmall>
    </div>
  );
}
