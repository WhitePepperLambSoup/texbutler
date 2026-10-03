// Visual table generator: rows × columns + alignment → booktabs three-line
// table code, or paste CSV / TSV (Excel copy) to convert real data.
import { useState } from "react";
import { useT } from "../i18n";
import Modal from "./ui/Modal";

interface Props {
  onCancel: () => void;
  onConfirm: (code: string) => void;
}

const clamp = (v: number) => Math.min(12, Math.max(1, Math.round(v)));

export default function TableModal({ onCancel, onConfirm }: Props) {
  const t = useT();
  const [mode, setMode] = useState<"grid" | "csv">("grid");
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(3);
  const [align, setAlign] = useState("lcc"); // one char per column
  const [header, setHeader] = useState(true);
  const [caption, setCaption] = useState("");
  const [csv, setCsv] = useState("");

  const wrap = (spec: string, body: string) => {
    const cap = caption.trim() ? `\\caption{${caption.trim()}}\n\\label{tab:${Date.now().toString(36)}}\n` : "";
    return `\\begin{table}[htbp]
\\centering
${cap}\\begin{tabular}{${spec}}
\\toprule
${body}
\\bottomrule
\\end{tabular}
\\end{table}
`;
  };

  /** Build a booktabs table from pasted CSV / TSV data (Excel copy-paste):
   *  first row = header when `header` is checked; quoted fields with
   *  embedded commas are handled. */
  const buildFromCsv = (): string => {
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const sep = lines.some((l) => l.includes("\t")) ? "\t" : ",";
    const parseRow = (l: string): string[] => {
      if (sep === "\t") return l.split("\t").map((c) => c.trim().replace(/^"|"$/g, ""));
      const parts: string[] = [];
      let cur = "";
      let inQ = false;
      for (const ch of l) {
        if (ch === '"') inQ = !inQ;
        else if (ch === "," && !inQ) {
          parts.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      parts.push(cur.trim());
      return parts;
    };
    const grid = lines.map(parseRow);
    const n = Math.max(...grid.map((r) => r.length));
    const rowsTex = grid.map((r) => `  ${Array.from({ length: n }, (_, c) => r[c] ?? "").join(" & ")} \\\\`);
    const body = header && rowsTex.length > 1 ? [rowsTex[0], "\\midrule", ...rowsTex.slice(1)].join("\n") : rowsTex.join("\n");
    return wrap("l".repeat(n), body);
  };

  const build = () => {
    const n = clamp(cols);
    let spec = align.slice(0, n).replace(/[^lcr]/g, "");
    while (spec.length < n) spec += "c";
    const cells = (fill: (c: number) => string) => `  ${Array.from({ length: n }, (_, c) => fill(c)).join(" & ")} \\\\`;
    const lines: string[] = [];
    if (header) lines.push(cells((c) => `${t("table.headerCell")}${c + 1}`), "\\midrule");
    for (let r = 0; r < clamp(rows) - (header ? 1 : 0); r++) lines.push(cells(() => ""));
    return wrap(spec, lines.join("\n"));
  };

  const confirm = () => {
    if (mode === "csv") {
      if (csv.trim()) onConfirm(buildFromCsv());
    } else onConfirm(build());
  };

  return (
    <Modal
      title={t("table.title")}
      onClose={onCancel}
      onSubmit={confirm}
      className="table-modal"
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={confirm} disabled={mode === "csv" && !csv.trim()}>
            {t("common.insert")}
          </button>
        </>
      }
    >
      <div className="market-tabs" role="tablist">
        <button className={`market-tab ${mode === "grid" ? "active" : ""}`} onClick={() => setMode("grid")}>
          {t("table.modeGrid")}
        </button>
        <button className={`market-tab ${mode === "csv" ? "active" : ""}`} onClick={() => setMode("csv")}>
          {t("table.modeCsv")}
        </button>
      </div>
      {mode === "grid" ? (
        <>
          <div className="field-grid">
            <label className="field">
              <span className="field-label">{t("table.rows")}</span>
              <input className="input" type="number" min={1} max={12} value={rows} onChange={(e) => setRows(clamp(Number(e.target.value) || 1))} />
            </label>
            <label className="field">
              <span className="field-label">{t("table.cols")}</span>
              <input className="input" type="number" min={1} max={12} value={cols} onChange={(e) => setCols(clamp(Number(e.target.value) || 1))} />
            </label>
            <label className="field">
              <span className="field-label">{t("table.align")}</span>
              <input
                className="input"
                value={align}
                onChange={(e) => setAlign(e.target.value.replace(/[^lcr]/g, "").slice(0, 12))}
                placeholder="lcc"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">{t("table.caption")}</span>
              <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t("table.captionPlaceholder")} />
            </label>
          </div>
          <div className="table-preview" aria-hidden="true">
            {Array.from({ length: Math.min(rows, 6) }, (_, r) => (
              <div key={r} className="table-preview-row">
                {Array.from({ length: Math.min(cols, 8) }, (_, c) => (
                  <span key={c} className={`table-preview-cell ${r === 0 && header ? "header" : ""}`}>
                    {r === 0 && header ? `H${c + 1}` : ""}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <textarea
            className="input table-csv-input"
            placeholder={t("table.csvPlaceholder")}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={7}
            spellCheck={false}
          />
          <label className="field">
            <span className="field-label">{t("table.caption")}</span>
            <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t("table.captionPlaceholder")} />
          </label>
        </>
      )}
      <label className="check-row">
        <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
        {t("table.header")}
      </label>
    </Modal>
  );
}
