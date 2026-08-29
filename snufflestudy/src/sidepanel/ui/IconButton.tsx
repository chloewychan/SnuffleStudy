import { type FunctionComponent } from "react";
import styles from "./IconButton.module.css";

export type IconButtonType = {
  className?: string;
  icon: string;
  label?: string;
  // v4.2 Task 5: frontend-backup's own IconButton.tsx has no interactivity at all (100% static
  // design, per the plan's own framing) - every real call site this task and later tasks need
  // (StudyRoomPopup's per-invitee trash icon here; NudgeVaultPanel/RestrictedSitesList/
  // DefaultFooter's own icon actions in later tasks) needs a real click handler and a real
  // disabled state. Additive, optional, backward-compatible - omitting either prop reproduces
  // the exact static behavior this component already had.
  onClick?: () => void;
  disabled?: boolean;
};

const IconButton: FunctionComponent<IconButtonType> = ({
  className = "",
  icon,
  label = "",
  onClick,
  disabled = false,
}) => {
  return (
    <button
      type="button"
      className={[styles.iconButton, className].join(" ")}
      onClick={onClick}
      disabled={disabled}
    >
      <span className={styles.badge} />
      <img className={styles.icon} alt={label} src={icon} />
    </button>
  );
};

export default IconButton;
