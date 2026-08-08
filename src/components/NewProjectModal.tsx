import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function NewProjectModal({ open, onClose }: Props) {
  const [parent, setParent] = useState("");
  const [name, setName] = useState("my-latex-project");
  const [busy, setBusy] = useState(false);
  const { createProject } = useProjectStore();
  const t = useT();

  const browseDir = async () => {
    try {
      const dir = await openDialog({ directory: true, title: t("newProject.browseTitle") });
      if (typeof dir === "string") setParent(dir);
    } catch {
      /* cancelled */
    }
  };

  if (!open) return null;

  const doCreate = async () => {
    if (!parent.trim()) {
      window.alert(t("newProject.parentRequired"));
      return;
    }
    if (!name.trim()) {
      window.alert(t("newProject.nameRequired"));
      return;
    }
    setBusy(true);
    try {
      await createProject(parent.trim(), name.trim(), "article");
      onClose();
    } catch (e) {
      window.alert(t("newProject.failed", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal new-project-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <span>{t("newProject.title")}</span>
          <button className="btn-mini" onClick={onClose} aria-label={t("settings.cancel")}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <label>
            {t("newProject.parent")}
            <div className="path-row">
              <input value={parent} placeholder="如 D:\\documents" onChange={(event) => setParent(event.target.value)} />
              <button className="btn-mini" type="button" onClick={() => void browseDir()}>
                {t("newProject.browse")}
              </button>
            </div>
          </label>
          <label>
            {t("newProject.name")}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn-mini" onClick={onClose}>
            {t("settings.cancel")}
          </button>
          <button className="btn-mini btn-primary" onClick={() => void doCreate()} disabled={busy}>
            {busy ? t("newProject.creating") : t("newProject.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
