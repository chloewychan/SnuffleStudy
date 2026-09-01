import type { ReactNode } from "react";
import { ButtonIcon } from "./ButtonIcon";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

// Shared shell for design-specs/frames/popup-*.json - each popup is the same [title, close] row
// over a White-50 card, no two of them differing in chrome. The "popup" in these Figma names is a
// modal/dialog rendered inside the side panel itself, not the WXT browser-action popup entrypoint
// (this extension has no such entrypoint at all).
export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div className="sp-modal-overlay" onClick={onClose}>
      <div
        className="sp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-modal__header">
          <h2>{title}</h2>
          <ButtonIcon icon="x" aria-label="Close" onClick={onClose} />
        </div>
        <div className="sp-modal__body">{children}</div>
      </div>
    </div>
  );
}
