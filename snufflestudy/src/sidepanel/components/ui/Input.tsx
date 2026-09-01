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

// design-specs/frames/input.json (component set 173:1659). Property=default/blank is this
// component's has-a-value vs. empty-placeholder mockup states, which map directly onto a real
// <input>'s value vs. ::placeholder styling rather than needing a separate prop. Type=dropdown
// (here, `variant` - "type" is reserved for the real HTML input type, text/email/password/etc.)
// renders a real <select> with the chevron-down glyph layered on top (native appearance removed) -
// dropdown's own text (the selected <option>) doesn't distinguish blank/default the way textbox's
// placeholder does, so that Property has no visible effect here.
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
