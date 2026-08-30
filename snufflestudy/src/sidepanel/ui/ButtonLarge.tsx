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

  // v4.2 Task 7 (Decision 5): frontend-backup's own ButtonLarge.tsx has no interactivity at all
  // (100% static design) - RequestUnlockForm.tsx (rebuilt fresh from this primitive, per Decision
  // 5) is the first real call site needing it to actually do something. Additive, optional,
  // backward-compatible - omitting either prop reproduces the exact prior static behavior. Mirrors
  // IconButton.tsx's identical extension in v4.2 Task 5.
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";

  // v4.2 Task 12: AccountPage.tsx's delete-account confirmation dialog has no frontend-backup
  // design frame at all (see that file's own header comment) - its "Yes, permanently delete"
  // action needs a visually distinct destructive/high-attention treatment, and neither Task 5's
  // archive-room nor Task 9's remove-friend action (the two precedents checked first) established
  // one to reuse - both render as plain default-styled ButtonLarge instances. An inline style
  // (rather than an extra CSS-module className) avoids depending on stylesheet import order to win
  // the cascade against this component's own .buttonLarge background rule. Additive, optional,
  // backward-compatible - omitting it reproduces the exact prior background for every other caller.
  buttonLargeBackgroundColor?: CSSProperties["backgroundColor"];
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
  onClick,
  disabled = false,
  type = "button",
  buttonLargeBackgroundColor,
}) => {
  const buttonLargeStyle: CSSProperties = useMemo(() => {
    return {
      borderRadius: buttonLargeBorderRadius,
      alignSelf: buttonLargeAlignSelf,
      width: buttonLargeWidth,
      backgroundColor: buttonLargeBackgroundColor,
    };
  }, [buttonLargeBorderRadius, buttonLargeAlignSelf, buttonLargeWidth, buttonLargeBackgroundColor]);

  const buttonStyle: CSSProperties = useMemo(() => {
    return {
      fontFamily: buttonFontFamily,
      margin: buttonMargin,
      fontWeight: buttonFontWeight,
    };
  }, [buttonFontFamily, buttonMargin, buttonFontWeight]);

  return (
    <button
      type={type}
      className={[styles.buttonLarge, className].join(" ")}
      data-property1={property1}
      style={buttonLargeStyle}
      onClick={onClick}
      disabled={disabled}
    >
      <h3 className={styles.button} style={buttonStyle}>
        {button}
      </h3>
    </button>
  );
};

export default ButtonLarge;
