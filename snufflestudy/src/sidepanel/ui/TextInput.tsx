import { useMemo, type FunctionComponent, type CSSProperties } from "react";
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
        className={styles.siteElements}
        placeholder={placeholder}
        type={entryFieldType}
        style={siteElementsStyle}
      />
    </div>
  );
};

export default TextInput;
