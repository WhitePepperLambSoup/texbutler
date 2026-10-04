import { useCallback, useEffect, useRef, useState } from "react";
import {
  Contrast,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Maximize2,
  Play,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useCompileStore } from "../store/compileStore";
import { useUiStore } from "../store/uiStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { revealLocation } from "../editorBridge";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";
import * as actions from "../actions";
import PdfViewer, { type PdfViewerHandle } from "./PdfViewer";

/**
 * PDF pane. The file is served by the restricted `tb-file` protocol
 * (`http://tb-file.localhost/<encoded path>`, project-internal paths only)
 * and rendered with pdf.js, which keeps the reading position across
 * recompiles and supports reverse SyncTeX (double-click).
 */
export default function PdfPreview() {
  const t = useT();
  const pdfPath = useProjectStore((s) => s.pdfPath);
  const root = useProjectStore((s) => s.root);
  const running = useCompileStore((s) => s.running);
  const lastResult = useCompileStore((s) => s.lastResult);
  const pdfTarget = useUiStore((s) => s.pdfTarget);
  const engine = useWorkspaceStore((s) => s.engine);
  const [revision, setRevision] = useState(0);
  const [invert, setInvert] = useState(() => localStorage.getItem("tb-pdf-invert") === "1");
  const [view, setView] = useState({ page: 1, pages: 0, scale: 1, loading: true, error: null as string | null });
  const [pageInput, setPageInput] = useState("");
  const handle = useRef<PdfViewerHandle | null>(null);
  const jump = useRef<((page: number) => void) | null>(null);

  // reload the viewer on every successful compile
  useEffect(
    () =>
      useCompileStore.subscribe((s, prev) => {
        if (s.lastResult?.ok && s.lastResult !== prev.lastResult) setRevision((r) => r + 1);
      }),
    [],
  );

  useEffect(() => {
    if (root && !engine) void useWorkspaceStore.getState().refreshEngine();
  }, [root, engine]);

  const onState = useCallback((s: typeof view) => setView(s), []);

  const onReverse = async (page: number, x: number, y: number) => {
    try {
      const hit = await api.synctexReverse(page, x, y);
      if (hit) await revealLocation(hit.file, hit.line);
      else toast.info(t("pdf.reverseNone"));
    } catch (e) {
      toast.error(e);
    }
  };

  const toggleInvert = () => {
    setInvert((v) => {
      localStorage.setItem("tb-pdf-invert", v ? "0" : "1");
      return !v;
    });
  };

  const hide = (
    <button
      className="icon-btn icon-btn-sm"
      title={t("pdf.hide")}
      aria-label={t("pdf.hide")}
      onClick={() => useUiStore.getState().setPanel("pdf", false)}
    >
      <X size={15} />
    </button>
  );

  if (!root || !pdfPath) {
    const noEngine = engine && !engine.can_compile;
    return (
      <div className="pdf-pane">
        <div className="panel-header">
          <span className="panel-title">{t("pdf.title")}</span>
          <span className="panel-actions">{hide}</span>
        </div>
        <div className="pdf-empty">
          <FileText size={40} />
          {noEngine ? (
            <>
              <div className="pdf-empty-title">{t("engine.missingTitle")}</div>
              <div>{t("engine.missingBody")}</div>
              <button className="btn btn-primary" onClick={() => useUiStore.getState().openModal({ kind: "engine" })}>
                {t("engine.setup")}
              </button>
            </>
          ) : (
            <>
              <div>{lastResult && !lastResult.ok ? t("pdf.failed") : t("pdf.empty")}</div>
              {root && (
                <button className="btn btn-primary" disabled={running} onClick={() => actions.compile()}>
                  {running ? <Loader2 size={14} className="spinner" /> : <Play size={14} />}
                  {running ? t("toolbar.compiling") : t("toolbar.compile")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const src = `http://tb-file.localhost/${encodeURIComponent(pdfPath)}`;
  return (
    <div className="pdf-pane">
      <div className="panel-header pdf-toolbar">
        <span className="pdf-page-nav" title={t("pdf.pageTitle")}>
          <input
            className="pdf-page-input"
            value={pageInput !== "" ? pageInput : String(view.page)}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onFocus={(e) => e.target.select()}
            onBlur={() => setPageInput("")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                jump.current?.(Number(pageInput || view.page));
                setPageInput("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label={t("pdf.pageTitle")}
          />
          <span className="pdf-page-total">/ {view.pages || "–"}</span>
        </span>
        <span className="pdf-zoom">
          <button className="icon-btn icon-btn-sm" title={t("pdf.zoomOut")} aria-label={t("pdf.zoomOut")} onClick={() => handle.current?.zoomOut()}>
            <ZoomOut size={15} />
          </button>
          <span className="pdf-zoom-value">{Math.round(view.scale * 100)}%</span>
          <button className="icon-btn icon-btn-sm" title={t("pdf.zoomIn")} aria-label={t("pdf.zoomIn")} onClick={() => handle.current?.zoomIn()}>
            <ZoomIn size={15} />
          </button>
          <button className="icon-btn icon-btn-sm" title={t("pdf.fitWidth")} aria-label={t("pdf.fitWidth")} onClick={() => handle.current?.fitWidth()}>
            <Maximize2 size={14} />
          </button>
        </span>
        <span className="toolbar-spacer" />
        <span className="panel-actions">
          <button
            className="icon-btn icon-btn-sm"
            aria-pressed={invert}
            title={t("pdf.invert")}
            aria-label={t("pdf.invert")}
            onClick={toggleInvert}
          >
            <Contrast size={14} />
          </button>
          <button className="icon-btn icon-btn-sm" title={t("pdf.reload")} aria-label={t("pdf.reload")} onClick={() => setRevision((r) => r + 1)}>
            <RotateCw size={14} />
          </button>
          <button className="icon-btn icon-btn-sm pdf-save-as" title={t("pdf.saveAs")} aria-label={t("pdf.saveAs")} onClick={() => void actions.savePdfAs()}>
            <Download size={14} />
          </button>
          <button className="icon-btn icon-btn-sm" title={t("pdf.outputFolder")} aria-label={t("pdf.outputFolder")} onClick={() => void actions.openOutputFolder()}>
            <FolderOpen size={14} />
          </button>
          <a className="icon-btn icon-btn-sm" href={src} target="_blank" rel="noreferrer" title={t("pdf.openNew")} aria-label={t("pdf.openNew")}>
            <ExternalLink size={14} />
          </a>
          {hide}
        </span>
      </div>
      <PdfViewer
        src={src}
        revision={revision}
        target={pdfTarget}
        invert={invert}
        onReverse={(p, x, y) => void onReverse(p, x, y)}
        onState={onState}
        handleRef={handle}
        jumpRef={jump}
      />
      {view.loading && view.pages === 0 && (
        <div className="pdf-loading">
          <Loader2 size={18} className="spinner" />
        </div>
      )}
    </div>
  );
}
