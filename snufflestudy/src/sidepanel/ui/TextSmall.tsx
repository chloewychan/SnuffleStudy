import { type FunctionComponent } from "react";
import styles from "./TextSmall.module.css";

export type TextSmallType = {
  className?: string;
  textbox?: string;

  /** Variant props */
  property1?: string;
};

const TextSmall: FunctionComponent<TextSmallType> = ({
  className = "",
  property1 = "white",
  textbox,
}) => {
  return (
    <div
      className={[styles.textSmall, className].join(" ")}
      data-property1={property1}
    >
      <h3 className={styles.textbox}>{textbox}</h3>
    </div>
  );
};

export default TextSmall;
