import { useEffect, useState } from "react";
import { ExternalLink, FileText, Loader2, Play, RotateCw, X } from "lucide-react";
import { useProjectStore } from "../store/projectStore";
import { useCompileStore } from "../store/compileStore";
import { useUiStore } from "../store/uiStore";
import { useT } from "../i18n";
import * as actions from "../actions";

/**
 * PDF preview via the restricted `tb-file` custom protocol. WebView2 does
 * not support non-standard schemes, so wry's workaround form is used:
 * `http://tb-file.localhost/<percent-encoded path>` (the Rust side maps it
 * back to the tb-file scheme and validates the path stays inside the open
 * project; `assetProtocol` is disabled). The iframe reloads after every
 * successful compile.
 */
export default function PdfPreview() {
  const t = useT();
  const pdfPath = useProjectStore((s) => s.pdfPath);
  const root = useProjectStore((s) => s.root);
  const running = useCompileStore((s) => s.running);
  const lastResult = useCompileStore((s) => s.lastResult);
  const pdfTarget = useUiStore((s) => s.pdfTarget);
  const [revision, setRevision] = useState(0);

  // reload the viewer on every successful compile
  useEffect(
    () =>
      useCompileStore.subscribe((s, prev) => {
        if (s.lastResult?.ok && s.lastResult !== prev.lastResult) setRevision((r) => r + 1);
      }),
    [],
  );

  const header = (
    <div className="panel-header">
      <span className="panel-title">{t("pdf.title")}</span>
      <span className="panel-actions">
        {pdfPath && (
          <>
            <button className="icon-btn icon-btn-sm" title={t("pdf.reload")} aria-label={t("pdf.reload")} onClick={() => setRevision((r) => r + 1)}>
              <RotateCw size={14} />
            </button>
            <a
              className="icon-btn icon-btn-sm"
              href={srcFor(pdfPath)}
              target="_blank"
              rel="noreferrer"
              title={t("pdf.openNew")}
              aria-label={t("pdf.openNew")}
            >
              <ExternalLink size={14} />
            </a>
          </>
        )}
        <button
          className="icon-btn icon-btn-sm"
          title={t("pdf.hide")}
          aria-label={t("pdf.hide")}
          onClick={() => useUiStore.getState().setPanel("pdf", false)}
        >
          <X size={15} />
        </button>
      </span>
    </div>
  );

  if (!root || !pdfPath) {
    return (
      <div className="pdf-pane">
        {header}
        <div className="pdf-empty">
          <FileText size={40} />
          <div>{lastResult && !lastResult.ok ? t("pdf.failed") : t("pdf.empty")}</div>
          {root && (
            <button className="btn btn-primary" disabled={running} onClick={() => actions.compile()}>
              {running ? <Loader2 size={14} className="spinner" /> : <Play size={14} />}
              {running ? t("toolbar.compiling") : t("toolbar.compile")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // SyncTeX forward search: `#page=N` is honored by the Edge PDF viewer
  const page = pdfTarget?.page;
  const src = `${srcFor(pdfPath)}${page ? `#page=${page}` : ""}`;
  return (
    <div className="pdf-pane">
      {header}
      <iframe key={`${revision}-${pdfTarget?.nonce ?? 0}`} src={src} title="PDF Preview" className="pdf-frame" />
    </div>
  );
}

function srcFor(pdfPath: string) {
  return `http://tb-file.localhost/${encodeURIComponent(pdfPath)}`;
}
