import { type FunctionComponent } from "react";
import styles from "./IconButton.module.css";

export type IconButtonType = {
  className?: string;
  icon: string;
  label?: string;
};

const IconButton: FunctionComponent<IconButtonType> = ({
  className = "",
  icon,
  label = "",
}) => {
  return (
    <button
      type="button"
      className={[styles.iconButton, className].join(" ")}
    >
      <span className={styles.badge} />
      <img className={styles.icon} alt={label} src={icon} />
    </button>
  );
};

export default IconButton;
