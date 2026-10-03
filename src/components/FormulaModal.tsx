// Formula editor: LaTeX input with live KaTeX preview + common templates.
import { useMemo, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { useT } from "../i18n";
import Modal from "./ui/Modal";

const TEMPLATES: { label: string; tex: string }[] = [
  { label: "a/b", tex: "\\frac{a}{b}" },
  { label: "√x", tex: "\\sqrt{x}" },
  { label: "ⁿ√x", tex: "\\sqrt[n]{x}" },
  { label: "x²", tex: "x^{2}" },
  { label: "xᵢ", tex: "x_{i}" },
  { label: "∑", tex: "\\sum_{i=1}^{n} a_i" },
  { label: "∫", tex: "\\int_{a}^{b} f(x)\\,dx" },
  { label: "lim", tex: "\\lim_{x \\to 0} \\frac{\\sin x}{x}" },
  { label: "v⃗", tex: "\\vec{v}" },
  { label: "matrix", tex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}" },
  { label: "cases", tex: "f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}" },
  { label: "∂f/∂x", tex: "\\frac{\\partial f}{\\partial x}" },
  { label: "a→b", tex: "a \\to b" },
  { label: "x∈A", tex: "x \\in A" },
  { label: "{x|…}", tex: "\\{ x \\mid x > 0 \\}" },
  { label: "a≤b", tex: "a \\leq b \\leq c" },
];

interface Props {
  mode: "inline" | "display";
  /** Pre-fill (e.g. the selected source). `$…$` wrappers are stripped. */
  initial?: string;
  onCancel: () => void;
  onConfirm: (code: string) => void;
}

export default function FormulaModal({ mode, initial, onCancel, onConfirm }: Props) {
  const t = useT();
  const [tex, setTex] = useState(() => {
    const src = initial?.trim().replace(/^\$\$?|\$\$?$/g, "").replace(/^\\\[|\\\]$/g, "").trim();
    return src || "E = mc^2";
  });
  const [display, setDisplay] = useState(mode === "display");

  const preview = useMemo(() => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch {
      return "";
    }
  }, [tex, display]);

  const insert = () => {
    const body = tex.trim();
    if (!body) return;
    onConfirm(display ? `\\[\n${body}\n\\]\n` : `$${body}$`);
  };

  return (
    <Modal
      title={t("formula.title")}
      onClose={onCancel}
      onSubmit={insert}
      className="formula-modal"
      footer={
        <>
          <span className="footer-note">
            <kbd>Ctrl</kbd> <kbd>Enter</kbd> {t("formula.insert")}
          </span>
          <button className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={insert} disabled={!tex.trim()}>
            {t("formula.insert")}
          </button>
        </>
      }
    >
      <div className="formula-preview" dangerouslySetInnerHTML={{ __html: preview }} />
      <textarea
        className="input formula-input"
        value={tex}
        onChange={(e) => setTex(e.target.value)}
        rows={3}
        spellCheck={false}
      />
      <div className="formula-templates">
        {TEMPLATES.map((tp) => (
          <button key={tp.tex} className="btn-mini" title={tp.tex} onClick={() => setTex(tp.tex)}>
            {tp.label}
          </button>
        ))}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} />
        {t("formula.display")}
      </label>
    </Modal>
  );
}
