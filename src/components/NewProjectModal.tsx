import { useEffect, useState } from "react";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** New-project dialog: parent dir + name + built-in template picker. */
export default function NewProjectModal({ open, onClose }: Props) {
  const [templates, setTemplates] = useState<{ id: string; name: string; source: string }[]>([]);
  const [parent, setParent] = useState("");
  const browseDir = async () => {
    try {
      const dir = await openDialog({ directory: true, title: t("newProject.browseTitle") });
      if (typeof dir === "string") setParent(dir);
    } catch {
      /* cancelled */
    }
  };
  const [name, setName] = useState("my-latex-project");
  const [template, setTemplate] = useState("article");
  const [busy, setBusy] = useState(false);
  const { createProject } = useProjectStore();
  const t = useT();

  useEffect(() => {
    if (open) {
      void api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
    }
  }, [open]);

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
      await createProject(parent.trim(), name.trim(), template);
      onClose();
    } catch (e) {
      window.alert(t("newProject.failed", { e: String(e) }));
    }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("newProject.title")}</span>
          <button className="btn-mini" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <label>
            {t("newProject.parent")}
            <div className="path-row">
              <input
                value={parent}
                placeholder="如 D:\documents"
                onChange={(e) => setParent(e.target.value)}
              />
              <button className="btn-mini" type="button" onClick={() => void browseDir()}>
                {t("newProject.browse")}
              </button>
            </div>
          </label>
          <label>
            {t("newProject.name")}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t("newProject.template")}
            <div className="template-grid">
              {templates.map((tp) => (
                <span key={tp.id} className="template-wrap">
                  <button
                    className={`template-card ${template === tp.id ? "template-active" : ""}`}
                    onClick={() => setTemplate(tp.id)}
                  >
                    {tp.name}
                  </button>
                  {tp.source === "user" && (
                    <button
                      className="btn-mini template-del"
                      title="删除模板"
                      onClick={async () => {
                        await api.deleteTemplate(tp.id).catch((e) => window.alert(String(e)));
                        void api.listTemplates().then(setTemplates).catch(() => undefined);
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
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
