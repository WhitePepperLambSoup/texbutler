import { useEffect, useState } from "react";
import { api, type ProjectFileNode } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useI18n, useT } from "../i18n";
import NewProjectModal from "./NewProjectModal";

function Node({
  node,
  depth,
  isMain,
  onContext,
}: {
  node: ProjectFileNode;
  depth: number;
  isMain: boolean;
  onContext: (e: React.MouseEvent, path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const activeTab = useProjectStore((s) => s.activeTab);
  const { openFile } = useProjectStore();
  const isOpen = activeTab === node.path;

  if (node.is_dir) {
    return (
      <div>
        <div
          className="tree-node tree-dir"
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => setOpen(!open)}
        >
          <span className="tree-arrow">{open ? "▾" : "▸"}</span>
          <span className="tree-icon"></span>
          {node.name}
        </div>
        {open &&
          node.children.map((c) => (
            <Node key={c.path} node={c} depth={depth + 1} isMain={isMain} onContext={onContext} />
          ))}
      </div>
    );
  }
  return (
    <div
      className={`tree-node ${isOpen ? "tree-active" : ""}`}
      style={{ paddingLeft: depth * 14 + 22 }}
      onClick={() => void openFile(node.path)}
      onContextMenu={(e) => onContext(e, node.path)}
      title={node.path}
    >
      <span className="tree-icon">
        {"•"}
      </span>
      {node.name}
      {isMain && <span className="tree-main-tag">{useI18n.getState().t("tree.mainTag")}</span>}
    </div>
  );
}

export default function ProjectTree() {
  const { root, files, mainFile, openProject, openFile } = useProjectStore();
  const [newOpen, setNewOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const t = useT();

  // File-tree auto-refresh is driven by the notify watcher
  // (tb://file-changed, debounced in compileStore) — no polling needed.

  // close the context menu on any click elsewhere
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const handleOpen = async () => {
    await openProject();
  };

  const setMain = async (path: string) => {
    setMenu(null);
    try {
      const info = await api.setMainFile(path);
      useProjectStore.setState({ mainFile: info.main_file });
    } catch (e) {
      window.alert(String(e));
    }
  };

  return (
    <div className="project-tree">
      <div className="panel-header">
        <span className="panel-title">{t("tree.title")}</span>
        <span className="panel-actions">
          <button className="btn-mini" title={t("toolbar.open")} onClick={handleOpen}>
            {t("toolbar.open")}
          </button>
          <button className="btn-mini" title={t("toolbar.new")} onClick={() => setNewOpen(true)}>
            {t("toolbar.new")}
          </button>
          <button
            className="btn-mini"
            title={t("tree.newFile")}
            disabled={!root}
            onClick={() => setNewFileOpen(true)}
          >
            {t("tree.newFileShort")}
          </button>
          <button
            className="btn-mini"
            title="将当前项目保存为模板"
            onClick={() => {
              const nm = window.prompt("模板名称", "my-template");
              if (!nm) return;
              void api.saveTemplate(nm).then(() => window.alert("模板已保存")).catch((e) => window.alert(String(e)));
            }}
          >
            {t("tree.saveTemplate")}
          </button>
        </span>
      </div>
      {root ? (
        <>
          <div className="tree-root" title={root}>
            <span className="tree-icon"></span>
            {root.split(/[\\/]/).pop() || root}
          </div>
          <div className="tree-body">
            {files.map((f) => (
              <Node
                key={f.path}
                node={f}
                depth={0}
                isMain={f.path === mainFile}
                onContext={(e, path) => {
                  e.preventDefault();
                  if (path.endsWith(".tex")) {
                    setMenu({ x: e.clientX, y: e.clientY, path });
                  }
                }}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="tree-empty">
          <p>{t("tree.noProject")}</p>
          <button onClick={handleOpen}>{t("tree.openFolder")}</button>
          <button onClick={() => setNewOpen(true)}>{t("tree.newProject")}</button>
        </div>
      )}
      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="ctx-item"
            disabled={menu.path === mainFile}
            onClick={() => void setMain(menu.path)}
          >
            {menu.path === mainFile ? t("tree.isMain") : t("tree.setMain")}
          </button>
        </div>
      )}
      <NewProjectModal open={newOpen} onClose={() => setNewOpen(false)} />
      {newFileOpen && (
        <NewFileModal
          onClose={() => setNewFileOpen(false)}
          onCreated={async (rel) => {
            setNewFileOpen(false);
            try {
              await openFile(rel);
            } catch (e) {
              window.alert(String(e));
            }
          }}
        />
      )}
    </div>
  );
}

/** Dialog: create a new file inside the project (`.tex` gets a template). */
function NewFileModal({ onClose, onCreated }: { onClose: () => void; onCreated: (rel: string) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState("new-file.tex");
  const [tpl, setTpl] = useState("article");
  const [busy, setBusy] = useState(false);
  const doCreate = async () => {
    const nm = name.trim();
    if (!nm) return;
    setBusy(true);
    try {
      await api.newFile(nm, nm.endsWith(".tex") ? tpl : undefined);
      await onCreated(nm);
    } catch (e) {
      window.alert(String(e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("tree.newFile")}</span>
          <button className="btn-mini" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <label>
            {t("tree.newFileName")}
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void doCreate()} />
          </label>
          {name.trim().endsWith(".tex") && (
            <label>
              {t("tree.newFileTemplate")}
              <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
                <option value="article">{t("tree.tplArticle")}</option>
                <option value="ctexart">{t("tree.tplCtexart")}</option>
                <option value="report">{t("tree.tplReport")}</option>
                <option value="beamer">{t("tree.tplBeamer")}</option>
                <option value="minimal">{t("tree.tplMinimal")}</option>
                <option value="">{t("tree.tplEmpty")}</option>
              </select>
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-mini" onClick={onClose}>
            {t("settings.cancel")}
          </button>
          <button className="btn-mini btn-primary" onClick={() => void doCreate()} disabled={busy}>
            {t("tree.newFileCreate")}
          </button>
        </div>
      </div>
    </div>
  );
}
