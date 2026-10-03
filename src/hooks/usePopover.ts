import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Open/close state for an anchored menu: closes on outside pointer-down and
 * on Escape (returning focus to the trigger). `anchorRef` wraps both the
 * trigger and the menu so clicks inside either keep it open.
 */
export function usePopover<A extends HTMLElement = HTMLDivElement, T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<A>(null);
  const triggerRef = useRef<T>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [open, close]);

  return { open, setOpen, toggle, close, anchorRef, triggerRef };
}
