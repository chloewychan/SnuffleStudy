import { useMemo, type FunctionComponent, type CSSProperties, type ChangeEvent } from "react";
import styles from "./TextInput.module.css";

export type TextInputType = {
  className?: string;
  placeholder?: string;
  entryFieldType?: string;

  /** Variant props */
  property1?: string;

  /** Style props */
  inputHeight?: CSSProperties["height"];
  inputBorderRadius?: CSSProperties["borderRadius"];
  inputWidth?: CSSProperties["width"];
  inputFlex?: CSSProperties["flex"];
  entryFieldFontFamily?: CSSProperties["fontFamily"];
  entryFieldDisplay?: CSSProperties["display"];
  entryFieldBorder?: CSSProperties["border"];
  entryFieldOutline?: CSSProperties["outline"];
  entryFieldBackgroundColor?: CSSProperties["backgroundColor"];
  entryFieldMargin?: CSSProperties["margin"];
  entryFieldFontWeight?: CSSProperties["fontWeight"];

  // v4.2 Task 7 (Decision 5): frontend-backup's own TextInput.tsx renders an uncontrolled,
  // static <input> (no value/onChange/disabled at all - a 100% static design). RequestUnlockForm's
  // hostname field (rebuilt fresh from this primitive) is the first real call site needing a
  // controlled input. Additive, optional, backward-compatible - omitting these reproduces the
  // exact prior static/uncontrolled behavior. Mirrors IconButton.tsx's/ButtonLarge.tsx's identical
  // extensions in v4.2 Tasks 5/7.
  id?: string;
  name?: string;
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  // v4.2 Task 9: FriendPanel.tsx's "Add Friend" field has no visible label text at all in the
  // design (only a placeholder) - this app's pre-existing accessible name for that field
  // ("Invite code") must carry forward regardless (Global Constraint), and there's no design text
  // to reuse as a real <label>. Additive/optional/backward-compatible, same extension pattern as
  // id/name/value/onChange/disabled above.
  ariaLabel?: string;
};

const TextInput: FunctionComponent<TextInputType> = ({
  className = "",
  property1 = "textbox",
  inputHeight,
  inputBorderRadius,
  inputWidth,
  inputFlex,
  placeholder,
  entryFieldType,
  entryFieldFontFamily,
  entryFieldDisplay,
  entryFieldBorder,
  entryFieldOutline,
  entryFieldBackgroundColor,
  entryFieldMargin,
  entryFieldFontWeight,
  id,
  name,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}) => {
  const inputStyle: CSSProperties = useMemo(() => {
    return {
      height: inputHeight,
      borderRadius: inputBorderRadius,
      width: inputWidth,
      flex: inputFlex,
    };
  }, [inputHeight, inputBorderRadius, inputWidth, inputFlex]);

  const siteElementsStyle: CSSProperties = useMemo(() => {
    return {
      fontFamily: entryFieldFontFamily,
      display: entryFieldDisplay,
      border: entryFieldBorder,
      outline: entryFieldOutline,
      backgroundColor: entryFieldBackgroundColor,
      margin: entryFieldMargin,
      fontWeight: entryFieldFontWeight,
    };
  }, [
    entryFieldFontFamily,
    entryFieldDisplay,
    entryFieldBorder,
    entryFieldOutline,
    entryFieldBackgroundColor,
    entryFieldMargin,
    entryFieldFontWeight,
  ]);

  return (
    <div
      className={[styles.input, className].join(" ")}
      data-property1={property1}
      style={inputStyle}
    >
      <input
        id={id}
        name={name}
        className={styles.siteElements}
        placeholder={placeholder}
        type={entryFieldType}
        style={siteElementsStyle}
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
      />
    </div>
  );
};

export default TextInput;
