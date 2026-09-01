import type { ButtonHTMLAttributes } from "react";

export type ButtonIconType =
  | "x"
  | "reload"
  | "options"
  | "info"
  | "trash"
  | "edit"
  | "play-pause"
  | "back";

const ICON_SRC: Record<ButtonIconType, string> = {
  x: "sidepanel/icons/x.svg",
  reload: "sidepanel/icons/reload.svg",
  options: "sidepanel/icons/options.svg",
  info: "sidepanel/icons/info.svg",
  trash: "sidepanel/icons/trash.svg",
  edit: "sidepanel/icons/edit.svg",
  "play-pause": "sidepanel/icons/play-pause.svg",
  back: "sidepanel/icons/back.svg",
};

interface ButtonIconProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "type"> {
  icon: ButtonIconType;
  "aria-label": string;
}

// design-specs/frames/button-icon.json (component set 168:1413). Property=hover is an ON_HOVER
// variant swap -> :hover, not a prop. Property=disabled maps onto the native disabled attribute.
// Icon-only, so aria-label is required rather than optional.
export function ButtonIcon({ icon, "aria-label": ariaLabel, ...rest }: ButtonIconProps) {
  return (
    <button type="button" className="sp-btn-icon" aria-label={ariaLabel} {...rest}>
      <img className="sp-btn-icon__glyph" src={chrome.runtime.getURL(ICON_SRC[icon])} alt="" />
    </button>
  );
}
