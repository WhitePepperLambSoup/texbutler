import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useT } from "../../i18n";

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Extra class on the dialog box (sizes, e2e hooks). */
  className?: string;
  /** Header content rendered before the close button. */
  headerExtra?: ReactNode;
  /** Ctrl/Cmd+Enter triggers this (the dialog's primary action). */
  onSubmit?: () => void;
}

/**
 * Shared dialog shell: backdrop click and Escape close, focus moves into the
 * dialog on open and returns to the previously focused control on close.
 */
export default function Modal({ title, onClose, children, footer, className, headerExtra, onSubmit }: ModalProps) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const submitRef = useRef(onSubmit);
  closeRef.current = onClose;
  submitRef.current = onSubmit;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    const first = box?.querySelector<HTMLElement>("[data-autofocus], input:not([type=checkbox]), textarea, select");
    (first ?? box)?.focus();
    const onKey = (e: KeyboardEvent) => {
      // only the top-most modal reacts
      const boxes = document.querySelectorAll(".modal");
      if (boxes[boxes.length - 1] !== boxRef.current) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && submitRef.current) {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={boxRef} className={`modal ${className ?? ""}`} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <span className="modal-header-actions">
            {headerExtra}
            <button className="icon-btn btn-ghost modal-close" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
