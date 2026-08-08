import { useEffect, useRef, useState } from "react";

/**
 * Windows-style splitter sizing: drag the separator bar between two panels
 * to resize the first one. Size is persisted in localStorage.
 */
export function usePanelSize(
  key: string,
  defaultSize: number,
  min: number,
  max: number
): { size: number; startDrag: (e: React.MouseEvent) => void; reset: () => void } {
  const [size, setSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (Number.isFinite(v) && v >= min && v <= max) return v;
    } catch {
      /* storage unavailable */
    }
    return defaultSize;
  });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    try {
      localStorage.setItem(key, String(size));
    } catch {
      /* ignore */
    }
  }, [key, size]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startPos = e.clientX;
    const startSize = sizeRef.current;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startPos;
      const next = Math.min(max, Math.max(min, startSize + delta));
      setSize(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const reset = () => setSize(defaultSize);
  return { size, startDrag, reset };
}

/** Same as usePanelSize but for vertical (height) drags. */
export function usePanelHeight(
  key: string,
  defaultSize: number,
  min: number,
  max: number
): { size: number; startDrag: (e: React.MouseEvent) => void; reset: () => void } {
  const [size, setSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (Number.isFinite(v) && v >= min && v <= max) return v;
    } catch {
      /* storage unavailable */
    }
    return defaultSize;
  });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    try {
      localStorage.setItem(key, String(size));
    } catch {
      /* ignore */
    }
  }, [key, size]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startPos = e.clientY;
    const startSize = sizeRef.current;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startPos;
      const next = Math.min(max, Math.max(min, startSize + delta));
      setSize(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  const reset = () => setSize(defaultSize);
  return { size, startDrag, reset };
}
