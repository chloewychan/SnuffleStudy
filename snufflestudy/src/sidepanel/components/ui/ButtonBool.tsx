import type { ButtonHTMLAttributes } from "react";

export type ButtonBoolIcon = "check" | "x";

const ICON_SRC: Record<ButtonBoolIcon, string> = {
  check: "sidepanel/icons/check.svg",
  // Same x.svg asset as ButtonIcon's "x" - the user exported it once, reused by both component sets.
  x: "sidepanel/icons/x.svg",
};

interface ButtonBoolProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  icon: ButtonBoolIcon;
  "aria-label": string;
}

// design-specs/frames/button-bool.json (component set 168:1418). Property=hover is an ON_HOVER
// variant swap -> :hover, not a prop. Property=disabled maps onto the native disabled attribute.
// Icon-only, so aria-label is required rather than optional.
export function ButtonBool({ icon, "aria-label": ariaLabel, ...rest }: ButtonBoolProps) {
  return (
    <button type="button" className="sp-btn-bool" aria-label={ariaLabel} {...rest}>
      <img className="sp-btn-bool__glyph" src={chrome.runtime.getURL(ICON_SRC[icon])} alt="" />
    </button>
  );
}
