// pdf.js-based viewer. Replaces the WebView2 built-in viewer, which could
// not report clicks (no reverse SyncTeX) and jumped back to page 1 on every
// recompile. Pages render lazily when they scroll into view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = "/pdfjs";

export interface PdfViewerHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitWidth: () => void;
}

interface Props {
  src: string;
  /** Changes after every successful compile: reload, keep the position. */
  revision: number;
  target: { page: number; y?: number; h?: number; nonce: number } | null;
  invert: boolean;
  onReverse: (page: number, x: number, y: number) => void;
  onState: (s: { page: number; pages: number; scale: number; loading: boolean; error: string | null }) => void;
  handleRef: React.MutableRefObject<PdfViewerHandle | null>;
  jumpRef: React.MutableRefObject<((page: number) => void) | null>;
}

interface PageSize {
  w: number;
  h: number;
}

const GAP = 12;
const loadedTasks = new WeakSet<object>();
const MIN_SCALE = 0.3;
const MAX_SCALE = 4;

export default function PdfViewer({ src, revision, target, invert, onReverse, onState, handleRef, jumpRef }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [scale, setScale] = useState<number>(() => Number(localStorage.getItem("tb-pdf-scale")) || 0);
  const [fitWidth, setFitWidth] = useState(() => localStorage.getItem("tb-pdf-fit") !== "0");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [marker, setMarker] = useState<{ page: number; y: number; h: number; nonce: number } | null>(null);
  const rendered = useRef(new Map<number, { scale: number; task?: RenderTask }>());
  const pending = useRef<{ page: number; frac: number } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  // ---- load (and reload after recompiles, remembering the position)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const el = scrollRef.current;
    if (el && sizes.length > 0) pending.current = positionOf(el, sizes, scale);
    const task = pdfjs.getDocument({
      url: src,
      cMapUrl: `${ASSETS}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}/standard_fonts/`,
      wasmUrl: `${ASSETS}/wasm/`,
      iccUrl: `${ASSETS}/iccs/`,
      disableRange: true,
      disableStream: true,
    });
    task.promise
      .then(async (next) => {
        const list: PageSize[] = [];
        for (let i = 1; i <= next.numPages; i++) {
          const page = await next.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          list.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) {
          void next.loadingTask.destroy();
          return;
        }
        loadedTasks.add(task);
        rendered.current.clear();
        setDoc((old) => {
          if (old && old !== next) void old.loadingTask.destroy();
          return next;
        });
        setSizes(list);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      // only abort a load still in flight; a finished one is owned by state
      if (!loadedTasks.has(task)) void task.destroy().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, revision]);

  // tear the last document down when the viewer unmounts
  const docRef = useRef<PDFDocumentProxy | null>(null);
  docRef.current = doc;
  useEffect(() => () => void docRef.current?.loadingTask.destroy(), []);

  // ---- fit width
  const computeFit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return 1;
    const widest = Math.max(...sizes.map((s) => s.w));
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, (el.clientWidth - 2 * GAP - 4) / widest));
  }, [sizes]);

  useLayoutEffect(() => {
    if (sizes.length === 0) return;
    if (fitWidth || !scale) setScale(computeFit());
  }, [sizes, fitWidth, computeFit, scale]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !fitWidth) return;
    const ro = new ResizeObserver(() => setScale(computeFit()));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitWidth, computeFit]);

  useEffect(() => {
    if (scale) localStorage.setItem("tb-pdf-scale", String(scale));
    localStorage.setItem("tb-pdf-fit", fitWidth ? "1" : "0");
  }, [scale, fitWidth]);

  const setZoom = useCallback(
    (next: number) => {
      const el = scrollRef.current;
      if (el && sizes.length) pending.current = positionOf(el, sizes, scale);
      setFitWidth(false);
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next * 100) / 100)));
    },
    [scale, sizes],
  );

  handleRef.current = {
    zoomIn: () => setZoom(scale * 1.15),
    zoomOut: () => setZoom(scale / 1.15),
    fitWidth: () => {
      const el = scrollRef.current;
      if (el && sizes.length) pending.current = positionOf(el, sizes, scale);
      setFitWidth(true);
      setScale(computeFit());
    },
  };

  const pageTop = useCallback(
    (page: number) => {
      let top = GAP;
      for (let i = 0; i < page - 1 && i < sizes.length; i++) top += sizes[i].h * scale + GAP;
      return top;
    },
    [sizes, scale],
  );

  jumpRef.current = (page: number) => {
    const el = scrollRef.current;
    if (!el || !sizes.length) return;
    el.scrollTop = pageTop(Math.min(Math.max(1, page), sizes.length)) - GAP;
  };

  // restore the remembered position after reload / zoom
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const p = pending.current;
    if (!el || !p || sizes.length === 0 || !scale) return;
    const page = Math.min(p.page, sizes.length);
    el.scrollTop = pageTop(page) + p.frac * sizes[page - 1].h * scale - GAP;
    pending.current = null;
  }, [sizes, scale, pageTop]);

  // ---- forward sync: scroll to the line and flash a marker
  useEffect(() => {
    const el = scrollRef.current;
    if (!target || !el || sizes.length === 0 || !scale) return;
    const page = Math.min(Math.max(1, target.page), sizes.length);
    const y = target.y ?? 0;
    el.scrollTop = pageTop(page) + y * scale - el.clientHeight / 3;
    if (target.y) setMarker({ page, y, h: target.h || 12, nonce: target.nonce });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.nonce, sizes.length, scale]);

  useEffect(() => {
    if (!marker) return;
    const id = window.setTimeout(() => setMarker(null), 2200);
    return () => window.clearTimeout(id);
  }, [marker]);

  // ---- current page + report state
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return;
    setCurrentPage(positionOf(el, sizes, scale).page);
  };

  useEffect(() => {
    onState({ page: currentPage, pages: sizes.length, scale, loading, error });
  }, [currentPage, sizes.length, scale, loading, error, onState]);

  // ---- lazy rendering
  const renderPage = useCallback(
    async (n: number, holder: HTMLDivElement) => {
      if (!doc) return;
      const prev = rendered.current.get(n);
      if (prev && prev.scale === scale) return;
      prev?.task?.cancel();
      const page = await doc.getPage(n);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.className = "pdf-canvas";
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      rendered.current.set(n, { scale, task });
      try {
        await task.promise;
      } catch {
        return; // cancelled by a newer render
      }
      if (rendered.current.get(n)?.task !== task) return;
      holder.querySelector(".pdf-canvas")?.remove();
      holder.querySelector(".textLayer")?.remove();
      holder.prepend(canvas);
      // selectable text on top of the canvas
      const textDiv = document.createElement("div");
      textDiv.className = "textLayer";
      textDiv.style.setProperty("--scale-factor", String(scale));
      textDiv.style.setProperty("--total-scale-factor", String(scale));
      holder.appendChild(textDiv);
      try {
        const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
        await layer.render();
      } catch {
        /* text layer is optional */
      }
    },
    [doc, scale],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc || !scale) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const holder = e.target as HTMLDivElement;
          void renderPage(Number(holder.dataset.page), holder);
        }
      },
      { root: el, rootMargin: "600px 0px" },
    );
    el.querySelectorAll<HTMLDivElement>(".pdf-page").forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [doc, scale, sizes, renderPage]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  };

  return (
    <div
      ref={scrollRef}
      className={`pdf-viewer ${invert ? "inverted" : ""}`}
      onScroll={onScroll}
      onWheel={onWheel}
      data-scale={scale}
      data-pages={sizes.length}
    >
      {error && <div className="pdf-error">{error}</div>}
      {sizes.map((s, i) => (
        <div
          key={`${revision}-${i}`}
          className="pdf-page"
          data-page={i + 1}
          style={{ width: Math.floor(s.w * scale), height: Math.floor(s.h * scale) }}
          onDoubleClick={(e) => {
            const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            onReverse(i + 1, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
          }}
        >
          {marker && marker.page === i + 1 && (
            <div
              key={marker.nonce}
              className="pdf-sync-marker"
              style={{ top: (marker.y - marker.h) * scale - 2, height: Math.max(marker.h * scale + 4, 6) }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** First visible page and how far into it the viewport top is (0..1). */
function positionOf(el: HTMLElement, sizes: PageSize[], scale: number): { page: number; frac: number } {
  const probe = el.scrollTop + GAP;
  let top = GAP;
  for (let i = 0; i < sizes.length; i++) {
    const h = sizes[i].h * scale;
    if (probe < top + h + GAP || i === sizes.length - 1) {
      return { page: i + 1, frac: Math.max(0, Math.min(1, (probe - top) / h)) };
    }
    top += h + GAP;
  }
  return { page: 1, frac: 0 };
}
