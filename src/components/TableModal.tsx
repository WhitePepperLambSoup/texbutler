// Visual table generator: rows × columns + alignment → booktabs three-line
// table code inserted at the cursor (same modal pattern as FormulaModal).
import { useState } from "react";
import { useT } from "../i18n";

interface Props {
  onCancel: () => void;
  onConfirm: (code: string) => void;
}

export default function TableModal({ onCancel, onConfirm }: Props) {
  const t = useT();
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(3);
  const [align, setAlign] = useState("lcc"); // one char per column
  const [header, setHeader] = useState(true);
  const [caption, setCaption] = useState("");
  const [csv, setCsv] = useState("");

  const clamp = (v: number) => Math.min(12, Math.max(1, Math.round(v)));

  /** Build a booktabs table from pasted CSV / TSV data (Excel copy-paste):
   *  first row = header when `header` is checked; quoted fields with
   *  embedded commas are handled. */
  const buildFromCsv = (): string => {
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const sep = lines.some((l) => l.includes("\t")) ? "\t" : ",";
    const parseRow = (l: string): string[] => {
      if (sep === "\t") return l.split("\t").map((c) => c.trim().replace(/^"|"$/g, ""));
      // CSV: split on commas outside double-quoted sections
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
    const cell = (r: number, c: number) => grid[r]?.[c] ?? "";
    const body = grid
      .map((_, r) => `  ${Array.from({ length: n }, (_, c) => cell(r, c)).join(" & ")} \\\\`)
      .join("\n");
    // first row as a bold header line when the header checkbox is on
    const headerLine = header && grid.length > 1
      ? body.split("\n")[0] + "\n\\midrule\n" + body.split("\n").slice(1).join("\n")
      : body;
    const cap = caption.trim()
      ? `  \\caption{${caption.trim()}}\n  \\label{tab:${Date.now().toString(36)}}\n`
      : "";
    return `\\begin{table}[H]
\\centering
${cap}\\begin{tabular}{${"l".repeat(n)}}
\\toprule
${headerLine}
\\bottomrule
\\end{tabular}
\\end{table}
`;
  };

  const build = () => {
    const n = clamp(cols);
    let spec = align
      .slice(0, n)
      .split("")
      .filter((c) => c === "l" || c === "c" || c === "r")
      .join("");
    while (spec.length < n) spec += "c";
    const cell = (r: number, c: number) => (r === 0 && header ? `表头${c + 1}` : "");
    const headerRow = header
      ? `\\toprule\n${Array.from({ length: n }, (_, c) => cell(0, c)).join(" & ")} \\\\\n\\midrule\n`
      : `\\toprule\n`;
    const body = Array.from({ length: clamp(rows) - (header ? 1 : 0) }, (_, r) =>
      Array.from({ length: n }, (_, c) => cell(r + 1, c)).join(" & ")
    )
      .map((row) => `  ${row} \\\\`)
      .join("\n");
    const cap = caption.trim()
      ? `  \\caption{${caption.trim()}}\n  \\label{tab:${Date.now().toString(36)}}\n`
      : "";
    return `\\begin{table}[H]
\\centering
${cap}\\begin{tabular}{${spec}}
${headerRow}  ${body}
\\bottomrule
\\end{tabular}
\\end{table}
`;
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box table-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("table.title")}</span>
          <button className="btn-mini" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="table-config">
            <label>
              {t("table.rows")}
              <input
                type="number"
                min={1}
                max={12}
                value={rows}
                onChange={(e) => setRows(clamp(Number(e.target.value) || 1))}
              />
            </label>
            <label>
              {t("table.cols")}
              <input
                type="number"
                min={1}
                max={12}
                value={cols}
                onChange={(e) => setCols(clamp(Number(e.target.value) || 1))}
              />
            </label>
            <label>
              {t("table.align")}
              <input
                value={align}
                onChange={(e) => setAlign(e.target.value.replace(/[^lcr]/g, "").slice(0, 12))}
                placeholder="lcc"
                spellCheck={false}
              />
            </label>
            <label className="table-header">
              <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
              {t("table.header")}
            </label>
          </div>
          <label className="table-caption">
            {t("table.caption")}
            <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t("table.captionPlaceholder")} />
          </label>
          <div className="table-csv">
            <textarea
              className="table-csv-input"
              placeholder={t("table.csvPlaceholder")}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={3}
              spellCheck={false}
            />
            <button
              className="btn btn-mini"
              disabled={!csv.trim()}
              onClick={() => {
                const code = buildFromCsv();
                if (code) onConfirm(code);
              }}
            >
              {t("table.csvGenerate")}
            </button>
          </div>
          <div className="table-preview" dir="ltr">
            {Array.from({ length: Math.min(rows, 6) }, (_, r) => (
              <div key={r} className="table-preview-row">
                {Array.from({ length: Math.min(cols, 6) }, (_, c) => (
                  <span key={c} className="table-preview-cell">
                    {r === 0 && header ? `H${c + 1}` : `${r + 1}-${c + 1}`}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={onCancel}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-primary" onClick={() => onConfirm(build())}>
              {t("common.insert")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
