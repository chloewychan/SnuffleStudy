import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

interface TextboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  variant?: "textbox";
  colour?: "white" | "beige";
}

interface DropdownProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  variant: "dropdown";
  colour?: "white" | "beige";
  children: ReactNode;
}

type InputProps = TextboxProps | DropdownProps;

// The has-a-value vs. empty-placeholder styling maps directly onto a real <input>'s value vs.
// ::placeholder, so it doesn't need a separate prop. `variant: "dropdown"` ("type" is reserved
// for the real HTML input type, text/email/password/etc.) renders a real <select> with the
// chevron-down glyph layered on top (native appearance removed) - the selected <option>'s text
// doesn't distinguish blank/default the way textbox's placeholder does.
export function Input(props: InputProps) {
  const colour = props.colour ?? "white";

  if (props.variant === "dropdown") {
    const { variant: _variant, colour: _colour, children, ...rest } = props;
    return (
      <span className={`sp-input sp-input--${colour} sp-input--dropdown`}>
        <select className="sp-input__select" {...rest}>
          {children}
        </select>
        <img
          className="sp-input__chevron"
          src={chrome.runtime.getURL("sidepanel/icons/chevron-down.svg")}
          alt=""
        />
      </span>
    );
  }

  const { variant: _variant, colour: _colour, ...rest } = props;
  return <input className={`sp-input sp-input--${colour}`} {...rest} />;
}
