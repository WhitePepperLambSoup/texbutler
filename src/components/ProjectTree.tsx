import { useEffect, useState } from "react";
import { api, type ProjectFileNode } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useI18n, useT } from "../i18n";
import NewProjectModal from "./NewProjectModal";

interface ProjectTreeProps {
  onNewFile: () => void;
}

type ProjectTreeComponent = (props: ProjectTreeProps) => React.ReactElement;

function Node({
  node,
  depth,
  isMain,
  onContext,
}: {
  node: ProjectFileNode;
  depth: number;
  isMain: boolean;
  onContext: (event: React.MouseEvent, path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const activeTab = useProjectStore((state) => state.activeTab);
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
          node.children.map((child) => (
            <Node key={child.path} node={child} depth={depth + 1} isMain={isMain} onContext={onContext} />
          ))}
      </div>
    );
  }

  return (
    <div
      className={`tree-node ${isOpen ? "tree-active" : ""}`}
      style={{ paddingLeft: depth * 14 + 22 }}
      onClick={() => void openFile(node.path)}
      onContextMenu={(event) => onContext(event, node.path)}
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

const ProjectTree: ProjectTreeComponent = ({ onNewFile }) => {
  const { root, files, mainFile, openProject } = useProjectStore();
  const [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const t = useT();

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
          <button className="btn-mini" title={t("toolbar.open")} onClick={() => void handleOpen()}>
            {t("toolbar.open")}
          </button>
          <button className="btn-mini" title={t("toolbar.new")} onClick={() => setNewOpen(true)}>
            {t("toolbar.new")}
          </button>
          <button
            className="btn-mini tree-new-file"
            title={t("tree.newFile")}
            disabled={!root}
            onClick={onNewFile}
          >
            {t("toolbar.newFile")}
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
            {files.map((file) => (
              <Node
                key={file.path}
                node={file}
                depth={0}
                isMain={file.path === mainFile}
                onContext={(event, path) => {
                  event.preventDefault();
                  if (path.endsWith(".tex")) setMenu({ x: event.clientX, y: event.clientY, path });
                }}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="tree-empty">
          <p>{t("tree.noProject")}</p>
          <button onClick={() => void handleOpen()}>{t("tree.openFolder")}</button>
          <button onClick={() => setNewOpen(true)}>{t("tree.newProject")}</button>
        </div>
      )}
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
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
};

export default ProjectTree;
