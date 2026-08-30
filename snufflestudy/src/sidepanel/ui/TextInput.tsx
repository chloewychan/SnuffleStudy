import {
  useMemo,
  type FunctionComponent,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
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
  // v4.2 Task 10: NudgeVaultPanel.tsx's written-nudge field needs to keep its pre-existing
  // Enter-submits behavior (NudgeVaultBox.tsx's own handleAddText, called on Enter as well as on
  // the check-icon click) - jsdom/Testing Library's fireEvent.keyDown doesn't simulate a real
  // browser's native "Enter in a text field implicitly submits the form" default action, so this
  // can't be carried forward via a <form> alone the way Tasks 4/9 did for fields with no existing
  // Enter-to-submit test coverage. Additive/optional/backward-compatible - omitting it reproduces
  // the exact prior behavior for every other caller.
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  // v4.2 Task 11: SettingsPage.tsx's hard-block passcode fields are looked up via
  // `getByTestId("old-passcode-input")`/etc. by OptionsApp.test.tsx (a suite this task doesn't
  // touch, since SettingsPage.tsx is shared unchanged logic per that file's own header comment) -
  // this primitive had no way to attach a data-testid before. Additive/optional/
  // backward-compatible, same extension pattern as ariaLabel/onKeyDown above.
  dataTestId?: string;
  // v4.2 Task 11: the quiet-hours start/end fields are real `type="number"` inputs (unchanged from
  // SettingsPage.tsx's pre-v4.2 markup) - min/max preserve the exact same 0-23 native constraint
  // they've always had. Additive/optional/backward-compatible.
  min?: number;
  max?: number;
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
  onKeyDown,
  dataTestId,
  min,
  max,
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
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={dataTestId}
        min={min}
        max={max}
      />
    </div>
  );
};

export default TextInput;
