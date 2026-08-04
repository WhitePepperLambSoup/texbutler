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
  const { root, files, mainFile, openProject } = useProjectStore();
  const [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const t = useT();

  // load recent projects whenever no project is open
  useEffect(() => {
    if (!useProjectStore.getState().root) {
      void api.recentProjects().then(setRecent).catch(() => setRecent([]));
    }
  }, [root]);
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
          {recent.length > 0 && (
            <div className="recent-list">
              <div className="recent-title">{t("tree.recent")}</div>
              {recent.map((p) => (
                <button
                  key={p}
                  className="recent-item"
                  title={p}
                  onClick={() => void openProject(p)}
                >
                  {p.split(/[\\/]/).pop() || p}
                </button>
              ))}
            </div>
          )}
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
    </div>
  );
}
