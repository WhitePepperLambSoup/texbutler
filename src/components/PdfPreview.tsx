import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

/**
 * PDF preview via the restricted `tb-file://` scheme (Rust side validates
 * the path stays inside the open project; `assetProtocol` is disabled).
 * The Rust side writes `.texbutler/build/main.pdf`; we render it in an
 * iframe with a reload key that bumps on every successful compile.
 */
export default function PdfPreview({ revision }: { revision: number }) {
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

  const src = `tb-file://localhost/${encodeURIComponent(pdfPath)}`;
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
