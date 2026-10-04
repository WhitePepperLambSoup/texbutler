import { useEffect, useMemo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  History,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import type { ProjectFileNode } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { gitBadge, useWorkspaceStore } from "../store/workspaceStore";
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

interface MenuTarget {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

type ContextHandler = (event: ReactMouseEvent, path: string, isDir: boolean) => void;

const DRAG_TYPE = "application/x-texbutler-path";

function dropHandlers(dir: string, setOver: (v: boolean) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      const from = e.dataTransfer.getData(DRAG_TYPE);
      setOver(false);
      if (!from) return;
      e.preventDefault();
      e.stopPropagation();
      void actions.movePathInto(from, dir);
    },
  };
}

function Node({ node, depth, onContext }: { node: ProjectFileNode; depth: number; onContext: ContextHandler }) {
  const activeTab = useProjectStore((s) => s.activeTab);
  const mainFile = useProjectStore((s) => s.mainFile);
  const dirty = useProjectStore((s) => (node.is_dir ? false : s.tabs.some((tab) => tab.path === node.path && tab.dirty)));
  const git = useWorkspaceStore((s) =>
    node.is_dir
      ? s.git?.files.some((f) => f.path.startsWith(`${node.path}/`)) ?? false
      : s.git?.files.find((f) => f.path === node.path) ?? null,
  );
  const containsActive = Boolean(node.is_dir && activeTab?.startsWith(`${node.path}/`));
  const [open, setOpen] = useState(depth < 1 || containsActive);
  const [over, setOver] = useState(false);
  const t = useT();

  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);

  const dragProps = {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, node.path);
      e.dataTransfer.effectAllowed = "move";
    },
  };

  if (node.is_dir) {
    return (
      <div role="treeitem" aria-expanded={open}>
        <button
          className={`tree-node tree-dir ${over ? "drop-target" : ""}`}
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => setOpen(!open)}
          onContextMenu={(event) => onContext(event, node.path, true)}
          title={node.path}
          data-path={node.path}
          {...dragProps}
          {...dropHandlers(node.path, setOver)}
        >
          <span className="tree-arrow">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          {open ? <FolderOpen size={15} className="tree-icon dir" /> : <Folder size={15} className="tree-icon dir" />}
          <span className="tree-name">{node.name}</span>
          {git && <span className="git-dot" title={t("git.containsChanges")} />}
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
  const badge = git && typeof git === "object" ? gitBadge(git.status) : null;
  return (
    <button
      role="treeitem"
      aria-selected={isActive}
      className={`tree-node ${isActive ? "tree-active" : ""}`}
      style={{ paddingLeft: depth * 14 + 20 }}
      onClick={() => void useProjectStore.getState().openFile(node.path).catch(toast.error)}
      onContextMenu={(event) => onContext(event, node.path, false)}
      title={node.path}
      data-path={node.path}
      {...dragProps}
    >
      <FileIcon name={node.name} />
      <span className={`tree-name ${badge ? badge.tone : ""}`}>{node.name}</span>
      {node.path === mainFile && <span className="tree-main-tag">{t("tree.mainTag")}</span>}
      {dirty && <span className="tree-dirty" title={t("editor.unsaved")} />}
      {badge && (
        <span className={`git-badge ${badge.tone}`} title={t(`git.${git && typeof git === "object" ? git.status : "modified"}`)}>
          {badge.letter}
        </span>
      )}
    </button>
  );
}

export default function ProjectTree() {
  const files = useProjectStore((s) => s.files);
  const mainFile = useProjectStore((s) => s.mainFile);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [rootOver, setRootOver] = useState(false);
  const t = useT();
  const rootDrop = useMemo(() => dropHandlers("", setRootOver), []);

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

  const openMenu = (event: ReactMouseEvent, path: string, isDir: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.min(event.clientX, window.innerWidth - 240);
    const y = Math.min(event.clientY, window.innerHeight - 360);
    setMenu({ x, y, path, isDir });
  };

  return (
    <div className="project-tree">
      <div
        className={`tree-body ${rootOver ? "drop-target" : ""}`}
        role="tree"
        {...rootDrop}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) openMenu(event, "", true);
        }}
      >
        {files.length === 0 && <div className="panel-empty">{t("tree.empty")}</div>}
        {files.map((file) => (
          <Node key={file.path} node={file} depth={0} onContext={openMenu} />
        ))}
      </div>
      {menu && (
        <div className="ctx-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {menu.isDir ? (
            <>
              <button className="ctx-item" onClick={run(() => useUiStore.getState().openModal({ kind: "newFile", dir: menu.path }))}>
                <FilePlus2 size={15} /> {t("files.newFileHere")}
              </button>
              <button className="ctx-item" onClick={run(() => void actions.newFolder(menu.path))}>
                <FolderPlus size={15} /> {t("files.newFolder")}
              </button>
            </>
          ) : (
            <>
              <button className="ctx-item" onClick={run(() => void useProjectStore.getState().openFile(menu.path))}>
                <FileText size={15} /> {t("tree.open")}
              </button>
              <button className="ctx-item" onClick={run(() => useUiStore.getState().setSplitFile(menu.path))}>
                <Columns2 size={15} /> {t("tree.openSplit")}
              </button>
              {menu.path.endsWith(".tex") && (
                <button className="ctx-item" disabled={menu.path === mainFile} onClick={run(() => void actions.setMainFile(menu.path))}>
                  <Star size={15} /> {menu.path === mainFile ? t("tree.isMain") : t("tree.setMain")}
                </button>
              )}
              <button className="ctx-item" onClick={run(() => actions.showHistory(menu.path))}>
                <History size={15} /> {t("history.title")}
              </button>
            </>
          )}
          {menu.path && (
            <>
              <div className="menu-separator" />
              <button className="ctx-item" onClick={run(() => void actions.renamePath(menu.path))}>
                <Pencil size={15} /> {t("files.rename")}
              </button>
              <button className="ctx-item" onClick={run(() => void actions.movePath(menu.path))}>
                <FolderInput size={15} /> {t("files.move")}
              </button>
              <button className="ctx-item" onClick={run(() => void actions.copyText(menu.path))}>
                <Copy size={15} /> {t("tree.copyPath")}
              </button>
            </>
          )}
          <button className="ctx-item" onClick={run(() => void actions.revealInExplorer(menu.path || null))}>
            <FolderSearch size={15} /> {t("files.reveal")}
          </button>
          {menu.path && (
            <>
              <div className="menu-separator" />
              <button className="ctx-item danger" onClick={run(() => void actions.deletePath(menu.path, menu.isDir))}>
                <Trash2 size={15} /> {t("common.delete")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
