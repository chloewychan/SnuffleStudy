import { type FunctionComponent } from "react";
import styles from "./ButtonBoolIcon.module.css";

export type ButtonBoolIconType = {
  className?: string;

  /** Variant props */
  property1?: string;
  property2?: string;
};

const ButtonBoolIcon: FunctionComponent<ButtonBoolIconType> = ({
  className = "",
  property1 = "check",
  property2 = "default",
}) => {
  return (
    <img
      className={[styles.buttonBoolIcon, className].join(" ")}
      loading="lazy"
      alt=""
      // v4.2 Task 1: frontend-backup's own root-absolute "/button-check.svg" doesn't resolve
      // inside a packed extension page - mirrors Header.tsx's confirmed-working
      // chrome.runtime.getURL(...) pattern. The physical file lives under
      // snufflestudy/public/sidepanel/assets/ (WXT copies public/ verbatim to the build root).
      src={chrome.runtime.getURL("sidepanel/assets/button-check.svg")}
      data-property1={property1}
      data-property2={property2}
    />
  );
};

export default ButtonBoolIcon;
