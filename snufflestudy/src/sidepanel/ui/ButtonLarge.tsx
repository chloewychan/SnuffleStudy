import { useMemo, type FunctionComponent, type CSSProperties } from "react";
import styles from "./ButtonLarge.module.css";

export type ButtonLargeType = {
  className?: string;
  button?: string;

  /** Variant props */
  property1?: string;

  /** Style props */
  buttonLargeBorderRadius?: CSSProperties["borderRadius"];
  buttonFontFamily?: CSSProperties["fontFamily"];
  buttonMargin?: CSSProperties["margin"];
  buttonFontWeight?: CSSProperties["fontWeight"];
  buttonLargeAlignSelf?: CSSProperties["alignSelf"];
  buttonLargeWidth?: CSSProperties["width"];
};

const ButtonLarge: FunctionComponent<ButtonLargeType> = ({
  className = "",
  property1 = "default",
  buttonLargeBorderRadius,
  button,
  buttonFontFamily,
  buttonMargin,
  buttonFontWeight,
  buttonLargeAlignSelf,
  buttonLargeWidth,
}) => {
  const buttonLargeStyle: CSSProperties = useMemo(() => {
    return {
      borderRadius: buttonLargeBorderRadius,
      alignSelf: buttonLargeAlignSelf,
      width: buttonLargeWidth,
    };
  }, [buttonLargeBorderRadius, buttonLargeAlignSelf, buttonLargeWidth]);

  const buttonStyle: CSSProperties = useMemo(() => {
    return {
      fontFamily: buttonFontFamily,
      margin: buttonMargin,
      fontWeight: buttonFontWeight,
    };
  }, [buttonFontFamily, buttonMargin, buttonFontWeight]);

  return (
    <button
      className={[styles.buttonLarge, className].join(" ")}
      data-property1={property1}
      style={buttonLargeStyle}
    >
      <h3 className={styles.button} style={buttonStyle}>
        {button}
      </h3>
    </button>
  );
};

export default ButtonLarge;
