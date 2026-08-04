// Image insert dialog: preview + width/position/caption options.
import { useState } from "react";
import { useT } from "../i18n";

interface Props {
  fileName: string;
  projectRoot: string;
  onCancel: () => void;
  onConfirm: (code: string) => void;
}

export default function ImageInsertModal({ fileName, projectRoot, onCancel, onConfirm }: Props) {
  const t = useT();
  const [width, setWidth] = useState("0.8");
  const [position, setPosition] = useState("H");
  const [caption, setCaption] = useState("");
  const [label, setLabel] = useState("");

  const buildCode = (): string => {
    const lines: string[] = [];
    if (position) {
      lines.push(`\\begin{figure}[${position}]`);
      lines.push("\\centering");
    }
    lines.push(
      `\\includegraphics[width=${width}\\linewidth]{${fileName}}`
    );
    if (caption.trim()) lines.push(`\\caption{${caption.trim()}}`);
    if (label.trim()) lines.push(`\\label{${label.trim()}}`);
    if (position) lines.push("\\end{figure}");
    return lines.join("\n") + "\n";
  };

  const src = `http://tb-file.localhost/${encodeURIComponent(`${projectRoot.replace(/\\/g, "/")}/${fileName}`)}`;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box image-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("image.title")}</span>
          <button className="btn-mini" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="image-preview">
            <img src={src} alt={fileName} />
          </div>
          <div className="image-options">
            <label>
              {t("image.width")}
              <select value={width} onChange={(e) => setWidth(e.target.value)}>
                <option value="0.3">0.3</option>
                <option value="0.5">0.5</option>
                <option value="0.8">0.8</option>
                <option value="1.0">1.0</option>
              </select>
              <span>{"\\linewidth"}</span>
            </label>
            <label>
              {t("image.position")}
              <select value={position} onChange={(e) => setPosition(e.target.value)}>
                <option value="H">H</option>
                <option value="htbp">htbp</option>
                <option value="">{t("image.inline")}</option>
              </select>
            </label>
            <label>
              {t("image.caption")}
              <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t("image.captionPh")} />
            </label>
            <label>
              {t("image.label")}
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="fig:name" />
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            {t("settings.cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onConfirm(buildCode());
            }}
          >
            {t("image.insert")}
          </button>
        </div>
      </div>
    </div>
  );
}
