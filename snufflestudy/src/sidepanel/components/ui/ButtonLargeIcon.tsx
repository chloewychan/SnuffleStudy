export type ButtonLargeIconType = "microphone" | "camera";

const ICON_SRC: Record<ButtonLargeIconType, { on: string; off: string }> = {
  microphone: {
    on: "sidepanel/icons/microphone-on.svg",
    off: "sidepanel/icons/microphone-off.svg",
  },
  camera: {
    on: "sidepanel/icons/camera-on.svg",
    off: "sidepanel/icons/camera-off.svg",
  },
};

interface ButtonLargeIconProps {
  icon: ButtonLargeIconType;
  enabled?: boolean;
  onClick?: () => void;
  "aria-label": string;
}

// design-specs/frames/button-large-icon.json (component set 173:2210). Property=default/selected is
// an ON_CLICK toggle (mic/camera on/off), not ON_HOVER, so it stays a real controlled "enabled" prop
// rather than CSS :hover. The provided assets include separate on/off glyphs per icon type (instead
// of one recolorable glyph), which maps naturally onto the same boolean that drives the selected
// (fully opaque) vs. default (75%-opacity) container styling the spec defines.
export function ButtonLargeIcon({ icon, enabled = false, onClick, "aria-label": ariaLabel }: ButtonLargeIconProps) {
  const src = enabled ? ICON_SRC[icon].on : ICON_SRC[icon].off;
  return (
    <button
      type="button"
      className={`sp-btn-large-icon${enabled ? " sp-btn-large-icon--selected" : ""}`}
      onClick={onClick}
      aria-pressed={enabled}
      aria-label={ariaLabel}
    >
      <img className="sp-btn-large-icon__glyph" src={chrome.runtime.getURL(src)} alt="" />
    </button>
  );
}
