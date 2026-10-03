import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Star,
} from "lucide-react";
import type { ProjectFileNode } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";
import * as actions from "../actions";

export function FileIcon({ name, size = 15 }: { name: string; size?: number }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "tex" || ext === "sty" || ext === "cls") return <FileCode2 size={size} className="tree-icon tex" aria-hidden="true" />;
  if (ext === "bib") return <BookMarked size={size} className="tree-icon bib" aria-hidden="true" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "eps", "pdf"].includes(ext)) {
    return <FileImage size={size} className="tree-icon img" aria-hidden="true" />;
  }
  if (["md", "txt", "log"].includes(ext)) return <FileText size={size} className="tree-icon" aria-hidden="true" />;
  return <File size={size} className="tree-icon" aria-hidden="true" />;
}

type ContextHandler = (event: ReactMouseEvent, path: string) => void;

function Node({ node, depth, onContext }: { node: ProjectFileNode; depth: number; onContext: ContextHandler }) {
  const activeTab = useProjectStore((s) => s.activeTab);
  const mainFile = useProjectStore((s) => s.mainFile);
  const dirty = useProjectStore((s) => (node.is_dir ? false : s.tabs.some((tab) => tab.path === node.path && tab.dirty)));
  const containsActive = Boolean(node.is_dir && activeTab?.startsWith(`${node.path}/`));
  const [open, setOpen] = useState(depth < 1 || containsActive);
  const t = useT();

  // reveal the active file: expand its folders when it changes
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);

  const pad = { paddingLeft: depth * 14 + 6 };

  if (node.is_dir) {
    return (
      <div role="treeitem" aria-expanded={open}>
        <button className="tree-node tree-dir" style={pad} onClick={() => setOpen(!open)} title={node.path}>
          <span className="tree-arrow">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          {open ? <FolderOpen size={15} className="tree-icon dir" /> : <Folder size={15} className="tree-icon dir" />}
          <span className="tree-name">{node.name}</span>
        </button>
        {open && (
          <div role="group">
            {node.children.map((child) => (
              <Node key={child.path} node={child} depth={depth + 1} onContext={onContext} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isActive = activeTab === node.path;
  return (
    <button
      role="treeitem"
      aria-selected={isActive}
      className={`tree-node ${isActive ? "tree-active" : ""}`}
      style={{ paddingLeft: depth * 14 + 20 }}
      onClick={() => void useProjectStore.getState().openFile(node.path).catch(toast.error)}
      onContextMenu={(event) => onContext(event, node.path)}
      title={node.path}
    >
      <FileIcon name={node.name} />
      <span className="tree-name">{node.name}</span>
      {node.path === mainFile && <span className="tree-main-tag">{t("tree.mainTag")}</span>}
      {dirty && <span className="tree-dirty" title={t("editor.unsaved")} />}
    </button>
  );
}

export default function ProjectTree() {
  const files = useProjectStore((s) => s.files);
  const mainFile = useProjectStore((s) => s.mainFile);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const t = useT();

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const run = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  return (
    <div className="project-tree">
      <div className="tree-body" role="tree">
        {files.length === 0 && <div className="panel-empty">{t("tree.empty")}</div>}
        {files.map((file) => (
          <Node
            key={file.path}
            node={file}
            depth={0}
            onContext={(event, path) => {
              event.preventDefault();
              const x = Math.min(event.clientX, window.innerWidth - 230);
              const y = Math.min(event.clientY, window.innerHeight - 180);
              setMenu({ x, y, path });
            }}
          />
        ))}
      </div>
      {menu && (
        <div
          className="ctx-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button className="ctx-item" onClick={run(() => void useProjectStore.getState().openFile(menu.path))}>
            <FileText size={15} /> {t("tree.open")}
          </button>
          <button className="ctx-item" onClick={run(() => useUiStore.getState().setSplitFile(menu.path))}>
            <Columns2 size={15} /> {t("tree.openSplit")}
          </button>
          {menu.path.endsWith(".tex") && (
            <button
              className="ctx-item"
              disabled={menu.path === mainFile}
              onClick={run(() => void actions.setMainFile(menu.path))}
            >
              <Star size={15} /> {menu.path === mainFile ? t("tree.isMain") : t("tree.setMain")}
            </button>
          )}
          <div className="menu-separator" />
          <button className="ctx-item" onClick={run(() => void actions.copyText(menu.path))}>
            <Copy size={15} /> {t("tree.copyPath")}
          </button>
        </div>
      )}
    </div>
  );
}
