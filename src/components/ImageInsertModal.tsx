// Image insert dialog: preview + width/position/caption options.
import { useState } from "react";
import { useT } from "../i18n";
import Modal from "./ui/Modal";

interface Props {
  fileName: string;
  projectRoot: string;
  onCancel: () => void;
  onConfirm: (code: string) => void;
}

export default function ImageInsertModal({ fileName, projectRoot, onCancel, onConfirm }: Props) {
  const t = useT();
  const [width, setWidth] = useState("0.8");
  const [position, setPosition] = useState("htbp");
  const [caption, setCaption] = useState("");
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
  const [label, setLabel] = useState(stem ? `fig:${stem}` : "");

  const buildCode = (): string => {
    const lines: string[] = [];
    if (position) {
      lines.push(`\\begin{figure}[${position}]`);
      lines.push("\\centering");
    }
    lines.push(`\\includegraphics[width=${width}\\linewidth]{${fileName}}`);
    if (position && caption.trim()) lines.push(`\\caption{${caption.trim()}}`);
    if (position && label.trim()) lines.push(`\\label{${label.trim()}}`);
    if (position) lines.push("\\end{figure}");
    return lines.join("\n") + "\n";
  };

  const src = `http://tb-file.localhost/${encodeURIComponent(`${projectRoot.replace(/\\/g, "/")}/${fileName}`)}`;
  const confirm = () => onConfirm(buildCode());

  return (
    <Modal
      title={t("image.title")}
      onClose={onCancel}
      onSubmit={confirm}
      className="image-modal"
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={confirm} data-autofocus>
            {t("image.insert")}
          </button>
        </>
      }
    >
      <div className="image-preview">
        <img src={src} alt={fileName} />
      </div>
      <code className="field-hint">{fileName}</code>
      <div className="field-grid">
        <label className="field">
          <span className="field-label">{t("image.width")}</span>
          <select className="input" value={width} onChange={(e) => setWidth(e.target.value)}>
            {["0.3", "0.5", "0.8", "1.0"].map((w) => (
              <option key={w} value={w}>
                {Math.round(Number(w) * 100)}% \linewidth
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t("image.position")}</span>
          <select className="input" value={position} onChange={(e) => setPosition(e.target.value)}>
            <option value="htbp">htbp</option>
            <option value="H">H</option>
            <option value="">{t("image.inline")}</option>
          </select>
        </label>
      </div>
      {position && (
        <div className="field-grid">
          <label className="field">
            <span className="field-label">{t("image.caption")}</span>
            <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t("image.captionPh")} />
          </label>
          <label className="field">
            <span className="field-label">{t("image.label")}</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="fig:name" />
          </label>
        </div>
      )}
    </Modal>
  );
}
