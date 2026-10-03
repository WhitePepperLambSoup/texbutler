import { useLayoutEffect, useState, type ReactNode } from "react";
import { usePopover } from "../../hooks/usePopover";

interface DropMenuProps {
  /** Trigger content (icon and/or text). */
  label: ReactNode;
  title: string;
  triggerClass?: string;
  menuClass?: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}

/**
 * Trigger + menu rendered with fixed positioning, so it is never clipped by
 * a scrolling toolbar (the editor format bar scrolls horizontally).
 */
export default function DropMenu({ label, title, triggerClass, menuClass, disabled, children }: DropMenuProps) {
  const pop = usePopover<HTMLSpanElement>();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!pop.open || !pop.triggerRef.current) return;
    const r = pop.triggerRef.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 340)), top: r.bottom + 4 });
  }, [pop.open, pop.triggerRef]);

  return (
    <span className="menu-anchor" ref={pop.anchorRef}>
      <button
        ref={pop.triggerRef}
        className={triggerClass ?? "icon-btn"}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        disabled={disabled}
        onClick={pop.toggle}
      >
        {label}
      </button>
      {pop.open && pos && (
        <div className={`menu ${menuClass ?? ""}`} role="menu" style={{ position: "fixed", left: pos.left, top: pos.top }}>
          {children(pop.close)}
        </div>
      )}
    </span>
  );
}
