// Formula editor: LaTeX input with live KaTeX preview + common templates.
import { useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { useT } from "../i18n";

const TEMPLATES: { label: string; tex: string }[] = [
  { label: "分数", tex: "\\frac{a}{b}" },
  { label: "根号", tex: "\\sqrt{x}" },
  { label: "n 次根", tex: "\\sqrt[n]{x}" },
  { label: "上标", tex: "x^{2}" },
  { label: "下标", tex: "x_{i}" },
  { label: "求和", tex: "\\sum_{i=1}^{n} a_i" },
  { label: "积分", tex: "\\int_{a}^{b} f(x)\\,dx" },
  { label: "极限", tex: "\\lim_{x \\to 0} \\frac{\\sin x}{x}" },
  { label: "向量", tex: "\\vec{v}" },
  { label: "矩阵", tex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}" },
  { label: "分段", tex: "f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}" },
  { label: "希腊 α", tex: "\\alpha" },
  { label: "希腊 β", tex: "\\beta" },
  { label: "偏导", tex: "\\frac{\\partial f}{\\partial x}" },
  { label: "箭头", tex: "a \\to b" },
  { label: "属于", tex: "x \\in A" },
  { label: "集合", tex: "\\{ x \\mid x > 0 \\}" },
  { label: "等于号", tex: "a \\leq b \\leq c" },
];

interface Props {
  mode: "inline" | "display";
  onCancel: () => void;
  onConfirm: (code: string) => void;
}

export default function FormulaModal({ mode, onCancel, onConfirm }: Props) {
  const t = useT();
  const [tex, setTex] = useState("E = mc^2");
  const [display, setDisplay] = useState(mode === "display");

  let preview = "";
  try {
    preview = katex.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch {
    preview = "";
  }

  const insert = () => {
    const body = tex.trim() || "E = mc^2";
    if (display) {
      onConfirm(`\\[\n${body}\n\\]\n`);
    } else {
      onConfirm(`$${body}$`);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box formula-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("formula.title")}</span>
          <button className="btn-mini" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="formula-preview" dangerouslySetInnerHTML={{ __html: preview }} />
          <textarea
            className="formula-input"
            value={tex}
            onChange={(e) => setTex(e.target.value)}
            rows={3}
            spellCheck={false}
          />
          <div className="formula-templates">
            {TEMPLATES.map((tp) => (
              <button key={tp.label} className="formula-tpl" title={tp.tex} onClick={() => setTex(tp.tex)}>
                {tp.label}
              </button>
            ))}
          </div>
          <label className="formula-mode">
            <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} />
            {t("formula.display")}
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            {t("settings.cancel")}
          </button>
          <button className="btn btn-primary" onClick={insert}>
            {t("formula.insert")}
          </button>
        </div>
      </div>
    </div>
  );
}
