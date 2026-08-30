import { type FunctionComponent } from "react";
import styles from "./ButtonSmall.module.css";

export type ButtonSmallType = {
  className?: string;

  /** Variant props */
  property1?: string;
  property2?: string;

  // v4.2 Task 8: frontend-backup's own ButtonSmall.tsx is a static, hardcoded "Play Nudge" label
  // with no interactivity at all (100% static design) - NudgesAndRequestsFooter.tsx's incoming
  // audio-nudge row (this component's first real call site) needs both a real click handler (the
  // existing lazy-download-then-play action) and a dynamic label ("Play" while idle, "Loading…"
  // while the audio blob downloads). Additive, optional, backward-compatible - omitting any of
  // these reproduces the exact prior static "Play Nudge" behavior. Mirrors IconButton.tsx's/
  // ButtonLarge.tsx's/TextInput.tsx's identical extensions in v4.2 Tasks 5/7.
  button?: string;
  onClick?: () => void;
  disabled?: boolean;
};

const ButtonSmall: FunctionComponent<ButtonSmallType> = ({
  className = "",
  property1 = "pink",
  property2 = "default",
  button = "Play Nudge",
  onClick,
  disabled = false,
}) => {
  return (
    <button
      type="button"
      className={[styles.buttonSmall, className].join(" ")}
      data-property1={property1}
      data-property2={property2}
      onClick={onClick}
      disabled={disabled}
    >
      <h3 className={styles.button}>{button}</h3>
    </button>
  );
};

export default ButtonSmall;
