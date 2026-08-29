import { type FunctionComponent } from "react";
import styles from "./ButtonSmall.module.css";

export type ButtonSmallType = {
  className?: string;

  /** Variant props */
  property1?: string;
  property2?: string;
};

const ButtonSmall: FunctionComponent<ButtonSmallType> = ({
  className = "",
  property1 = "pink",
  property2 = "default",
}) => {
  return (
    <button
      className={[styles.buttonSmall, className].join(" ")}
      data-property1={property1}
      data-property2={property2}
    >
      <h3 className={styles.button}>Play Nudge</h3>
    </button>
  );
};

export default ButtonSmall;
