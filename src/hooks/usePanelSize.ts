import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type GrowthDirection = 1 | -1;
type DragAxis = "x" | "y";
type DragStart = (event: ReactPointerEvent<HTMLElement>) => void;

interface PanelDimension {
  size: number;
  startDrag: DragStart;
  reset: () => void;
}

function usePanelDimension(
  key: string,
  defaultSize: number,
  min: number,
  max: number,
  axis: DragAxis,
  growthDirection: GrowthDirection,
): PanelDimension {
  const [size, setSize] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= min && value <= max) return value;
      }
    } catch {
      // Storage may be unavailable in restricted WebViews.
    }
    return defaultSize;
  });
  const sizeRef = useRef(size);
  const cleanupRef = useRef<null | (() => void)>(null);
  sizeRef.current = size;

  useEffect(() => {
    try {
      localStorage.setItem(key, String(size));
    } catch {
      // Persistence is best-effort; the in-memory size remains valid.
    }
  }, [key, size]);

  useEffect(() => () => {
    cleanupRef.current?.();
  }, []);

  const startDrag: DragStart = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupRef.current?.();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startPosition = axis === "x" ? event.clientX : event.clientY;
    const startSize = sizeRef.current;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", finish);
      try {
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch {
        // Native cancellation may already have released the pointer.
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (cleanupRef.current === finish) cleanupRef.current = null;
    }

    function onMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      if (moveEvent.buttons === 0) {
        finish();
        return;
      }
      const position = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
      const delta = (position - startPosition) * growthDirection;
      const next = Math.min(max, Math.max(min, startSize + delta));
      sizeRef.current = next;
      setSize(next);
    }

    function onEnd(endEvent: PointerEvent) {
      if (endEvent.pointerId === pointerId) finish();
    }

    cleanupRef.current = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", finish);
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Synthetic tests and older hosts may not expose native capture.
    }
  };

  const reset = () => {
    sizeRef.current = defaultSize;
    setSize(defaultSize);
  };
  return { size, startDrag, reset };
}

/** Resize a panel whose dimension follows horizontal pointer movement. */
export function usePanelSize(
  key: string,
  defaultSize: number,
  min: number,
  max: number,
  growthDirection: GrowthDirection = 1,
): PanelDimension {
  return usePanelDimension(key, defaultSize, min, max, "x", growthDirection);
}

/** Resize a panel whose dimension follows vertical pointer movement. */
export function usePanelHeight(
  key: string,
  defaultSize: number,
  min: number,
  max: number,
  growthDirection: GrowthDirection = 1,
): PanelDimension {
  return usePanelDimension(key, defaultSize, min, max, "y", growthDirection);
}
