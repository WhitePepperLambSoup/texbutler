import { useEffect, useState } from "react";
import { useUiStore, type PanelId } from "../store/uiStore";

export const EDITOR_MIN = 360;
export const AI_RAIL = 36;
const PDF_MIN = 260;
const TREE_MIN = 180;
const SPLITTER = 6;

export interface LayoutFit {
  tree: number;
  pdf: number;
  ai: number;
  showTree: boolean;
  showPdf: boolean;
  showAi: boolean;
}

/**
 * Fit the user's preferred pane sizes into the window: the editor always
 * keeps EDITOR_MIN. When space runs out, panes first shrink to their
 * minimum, then hide — AI first, then PDF, then the sidebar — except the
 * pane the user opened most recently, which is hidden last. Preferences are
 * untouched, so widening the window brings everything back.
 */
export function fitLayout(
  width: number,
  want: { tree: number; pdf: number; ai: number },
  open: { sidebar: boolean; pdf: boolean; ai: boolean },
  lastOpened: PanelId | null,
  gap: number,
): LayoutFit {
  const fit: LayoutFit = {
    tree: want.tree,
    pdf: want.pdf,
    ai: want.ai,
    showTree: open.sidebar,
    showPdf: open.pdf,
    showAi: open.ai,
  };
  const used = () =>
    (fit.showTree ? fit.tree + SPLITTER + gap : 0) +
    (fit.showPdf ? fit.pdf + SPLITTER + gap : 0) +
    (fit.showAi ? fit.ai + SPLITTER + gap : AI_RAIL + gap) +
    EDITOR_MIN +
    gap * 2;
  const over = () => used() - width;

  if (over() > 0 && fit.showPdf) fit.pdf = Math.max(PDF_MIN, fit.pdf - over());
  if (over() > 0 && fit.showAi) fit.ai = Math.max(260, fit.ai - over());
  if (over() > 0 && fit.showTree) fit.tree = Math.max(TREE_MIN, fit.tree - over());

  const hideOrder: ("ai" | "pdf" | "sidebar")[] = ["ai", "pdf", "sidebar"];
  if (lastOpened && lastOpened !== "bottom") {
    hideOrder.splice(hideOrder.indexOf(lastOpened), 1);
    hideOrder.push(lastOpened);
  }
  for (const panel of hideOrder) {
    if (over() <= 0) break;
    if (panel === "ai") fit.showAi = false;
    if (panel === "pdf") fit.showPdf = false;
    if (panel === "sidebar") fit.showTree = false;
  }
  return fit;
}

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth || 1280);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return width;
}

export function useLayoutFit(want: { tree: number; pdf: number; ai: number }): LayoutFit {
  const width = useWindowWidth();
  const panels = useUiStore((s) => s.panels);
  const lastOpened = useUiStore((s) => s.lastOpened);
  const theme = useUiStore((s) => s.theme);
  const gap = theme === "liquid" ? (width <= 1100 ? 4 : 8) : 0;
  return fitLayout(width, want, panels, lastOpened, gap);
}
