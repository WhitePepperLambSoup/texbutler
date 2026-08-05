import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

/**
 * PDF preview via the restricted `tb-file` custom protocol. WebView2 does
 * not support non-standard schemes, so wry's workaround form is used:
 * `http://tb-file.localhost/<percent-encoded path>` (the Rust side maps it
 * back to the tb-file scheme and validates the path stays inside the open
 * project; `assetProtocol` is disabled). We render it in an iframe with a
 * reload key that bumps on every successful compile.
 */
export default function PdfPreview({ revision, page }: { revision: number; page?: number }) {
  const { pdfPath, root } = useProjectStore();
  const t = useT();

  if (!root || !pdfPath) {
    return (
      <div className="pdf-pane">
        <div className="panel-header">
          <span className="panel-title">{t("pdf.title")}</span>
        </div>
        <div className="pdf-empty">{t("pdf.empty")}</div>
      </div>
    );
  }

  // SyncTeX forward search: `#page=N` is honored by the Edge PDF viewer
  const src = `http://tb-file.localhost/${encodeURIComponent(pdfPath)}${page ? `#page=${page}` : ""}`;
  return (
    <div className="pdf-pane">
      <div className="panel-header">
        <span className="panel-title">{t("pdf.title")}</span>
        <span className="panel-actions">
          <a className="btn-mini" href={src} target="_blank" rel="noreferrer">
            {t("pdf.openNew")}
          </a>
        </span>
      </div>
      <iframe
        key={revision}
        src={src}
        title="PDF Preview"
        className="pdf-frame"
      />
    </div>
  );
}
