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

// design-specs/frames/video-box.json (component set 177:2719) - Property=default/selected is an
// ON_CLICK toggle (design-specs/frames/footer-study-room.json), not an ON_HOVER variant swap, so
// "selected" stays a real prop. The spec captures no visual delta between the two variants beyond
// the property name, so "selected" reuses this codebase's existing tile-selection treatment
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
