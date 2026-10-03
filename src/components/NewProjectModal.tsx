import { useState } from "react";
import { FolderSearch } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";
import Modal from "./ui/Modal";

const PARENT_KEY = "tb-new-project-parent";

/** Built-in seeds accepted by tb_new_project (core::project::templates). */
const TEMPLATES = [
  { id: "article", label: "newProject.tpl.article", desc: "newProject.tpl.articleDesc" },
  { id: "article-en", label: "newProject.tpl.articleEn", desc: "newProject.tpl.articleEnDesc" },
  { id: "report", label: "newProject.tpl.report", desc: "newProject.tpl.reportDesc" },
  { id: "beamer", label: "newProject.tpl.beamer", desc: "newProject.tpl.beamerDesc" },
  { id: "blank", label: "newProject.tpl.blank", desc: "newProject.tpl.blankDesc" },
] as const;

export default function NewProjectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [parent, setParent] = useState(() => localStorage.getItem(PARENT_KEY) ?? "");
  const [name, setName] = useState("my-latex-project");
  const [template, setTemplate] = useState<string>("article");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browseDir = async () => {
    try {
      const dir = await openDialog({ directory: true, title: t("newProject.browseTitle"), defaultPath: parent || undefined });
      if (typeof dir === "string") setParent(dir);
    } catch {
      /* cancelled */
    }
  };

  const doCreate = async () => {
    setError(null);
    if (!parent.trim()) return setError(t("newProject.parentRequired"));
    if (!name.trim()) return setError(t("newProject.nameRequired"));
    if (/[\\/:*?"<>|]/.test(name.trim())) return setError(t("newProject.nameInvalid"));
    setBusy(true);
    try {
      await useProjectStore.getState().createProject(parent.trim(), name.trim(), template);
      localStorage.setItem(PARENT_KEY, parent.trim());
      onClose();
    } catch (e) {
      setError(t("newProject.failed", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("newProject.title")}
      onClose={onClose}
      onSubmit={() => void doCreate()}
      className="new-project-modal"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={() => void doCreate()} disabled={busy}>
            {busy ? t("newProject.creating") : t("newProject.create")}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{t("newProject.name")}</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void doCreate()}
        />
      </label>
      <div className="field">
        <span className="field-label">{t("newProject.parent")}</span>
        <div className="field-row">
          <input className="input" value={parent} placeholder="D:\\documents" onChange={(event) => setParent(event.target.value)} />
          <button className="btn" type="button" onClick={() => void browseDir()}>
            <FolderSearch size={15} /> {t("newProject.browse")}
          </button>
        </div>
        {parent.trim() && name.trim() && (
          <span className="field-hint">
            {t("newProject.willCreate")} <code>{`${parent.trim().replace(/[\\/]+$/, "")}\\${name.trim()}`}</code>
          </span>
        )}
      </div>
      <div className="field">
        <span className="field-label">{t("newProject.template")}</span>
        <div className="template-grid">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              data-template-id={tpl.id}
              className={`template-card ${template === tpl.id ? "template-active" : ""}`}
              onClick={() => setTemplate(tpl.id)}
            >
              {t(tpl.label)}
              <span className="template-card-desc">{t(tpl.desc)}</span>
            </button>
          ))}
        </div>
        <span className="field-hint">{t("newProject.marketHint")}</span>
      </div>
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}
