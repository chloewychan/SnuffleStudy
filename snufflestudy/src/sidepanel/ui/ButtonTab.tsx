import { type FunctionComponent } from "react";
import styles from "./ButtonTab.module.css";

export type ButtonTabType = {
  className?: string;
  button?: string;

  /** Variant props */
  property1?: string;
};

const ButtonTab: FunctionComponent<ButtonTabType> = ({
  className = "",
  property1 = "default",
  button,
}) => {
  return (
    <div
      className={[styles.root, className].join(" ")}
      data-property1={property1}
    >
      <div className={styles.button}>{button}</div>
    </div>
  );
};

export default ButtonTab;
